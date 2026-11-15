// T3 Code (github.com/pingdotgg/t3code) runs coding agents for its threads, but only while a
// thread is active: an idle thread has no process. Its database names every thread, so live
// agents can show their thread's title and whether T3 is waiting for an answer, and open threads
// that have no process can still be listed. Read-only, and only when the file has changed; any
// schema it doesn't recognize (T3 Code is in beta) just means no T3 information.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProcRow } from "./core";

export type T3Thread = {
	id: string;
	title: string;
	/** Our agent id: "claude", "codex", … (T3's provider, mapped). */
	harness: string;
	project?: string;
	/** Where its agent runs: the thread's worktree, else its project's folder. */
	cwd?: string;
	branch?: string;
	/** The agent session ids it has run as (Claude Code session, Codex thread). */
	sessions: string[];
	/** The session it would resume. */
	session?: string;
	state: "working" | "waiting" | "idle";
	/** Epoch ms of its latest run, or of the thread's last change. */
	lastActive: number;
	snoozedUntil?: number;
	/** In T3 Code's sidebar: not archived, settled or a subagent. */
	open: boolean;
};

const HARNESS: Record<string, string> = { claudeAgent: "claude", codex: "codex", opencode: "opencode", cursor: "cursor", gemini: "gemini" };
const ACTIVE_RUN = new Set(["queued", "preparing", "starting", "running", "waiting"]);

export const t3Database = (env = process.env) => join(env.T3CODE_HOME || join(homedir(), ".t3"), "userdata", "statev2.sqlite");

const THREADS = `select t.thread_id id, t.title, t.default_provider provider, t.updated_at updatedAt, t.active_provider_thread_id active,
	json_extract(t.payload_json, '$.worktreePath') worktree, json_extract(t.payload_json, '$.branch') branch,
	json_extract(t.payload_json, '$.settledAt') settledAt, json_extract(t.payload_json, '$.snoozedUntil') snoozedUntil,
	json_extract(t.payload_json, '$.lineage.relationshipToParent') relation, p.title project, p.workspace_root root,
	(select r.status from orchestration_v2_projection_runs r where r.thread_id = t.thread_id order by r.ordinal desc limit 1) run,
	(select max(coalesce(r.completed_at, r.requested_at)) from orchestration_v2_projection_runs r where r.thread_id = t.thread_id) lastRunAt,
	(select count(*) from orchestration_v2_projection_runtime_requests q where q.thread_id = t.thread_id and q.status = 'pending') pending
	from orchestration_v2_projection_threads t left join projection_projects p on p.project_id = t.project_id
	where t.deleted_at is null and t.archived_at is null`;
const SESSIONS = `select thread_id threadId, provider_thread_id id, json_extract(payload_json, '$.nativeThreadRef.nativeId') nativeId from orchestration_v2_projection_provider_threads`;

type ThreadRow = { id: string; title: string; provider: string; updatedAt: string; active: string | null; worktree: string | null; branch: string | null; settledAt: string | null; snoozedUntil: string | null; relation: string | null; project: string | null; root: string | null; run: string | null; lastRunAt: string | null; pending: number };
type SessionRow = { threadId: string; id: string; nativeId: string | null };

/** Threads from rows read out of T3 Code's database (pure, for tests). */
export function toThreads(rows: ThreadRow[], sessions: SessionRow[], now = Date.now()): T3Thread[] {
	const byThread = new Map<string, SessionRow[]>();
	for (const s of sessions) if (s.nativeId && !s.nativeId.startsWith("pending:")) byThread.set(s.threadId, [...(byThread.get(s.threadId) ?? []), s]);
	return rows.map((r) => {
		const own = byThread.get(r.id) ?? [];
		const snoozedUntil = r.snoozedUntil ? Date.parse(r.snoozedUntil) : undefined;
		return {
			id: r.id,
			title: r.title,
			harness: HARNESS[r.provider] ?? r.provider,
			project: r.project ?? undefined,
			cwd: r.worktree ?? r.root ?? undefined,
			branch: r.branch ?? undefined,
			sessions: own.map((s) => s.nativeId!),
			session: (own.find((s) => s.id === r.active) ?? own.at(-1))?.nativeId ?? undefined,
			state: r.pending > 0 ? "waiting" : r.run && ACTIVE_RUN.has(r.run) ? "working" : "idle",
			lastActive: Date.parse(r.lastRunAt ?? r.updatedAt) || 0,
			snoozedUntil: snoozedUntil && snoozedUntil > now ? snoozedUntil : undefined,
			open: !r.settledAt && r.relation !== "subagent",
		};
	});
}

let cache: { key: string; threads: T3Thread[] } | null = null;
/** T3 Code's threads, or none when it isn't installed or its database can't be read. */
export function readT3Threads(path = t3Database()): T3Thread[] {
	try {
		if (!existsSync(path)) return [];
		const key = [path, statSync(path).mtimeMs, existsSync(path + "-wal") ? statSync(path + "-wal").mtimeMs : 0].join(":");
		if (cache?.key === key) return cache.threads;
		const db = new Database(path, { readonly: true });
		try {
			const threads = toThreads(db.query(THREADS).all() as ThreadRow[], db.query(SESSIONS).all() as SessionRow[]);
			cache = { key, threads };
			return threads;
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}

/** Which thread a live agent process is: by its session id, else (for an agent T3 Code
 *  started) by the folder it runs in. */
export function threadOf(r: ProcRow, threads: T3Thread[]): T3Thread | undefined {
	const session = r.agent?.sessionId;
	const bySession = session ? threads.find((t) => t.sessions.includes(session)) : undefined;
	if (bySession || !r.agent || !isT3(r.where)) return bySession;
	const here = threads.filter((t) => t.cwd === r.cwd && t.harness === r.agent!.harness);
	return here.length === 1 ? here[0] : undefined;
}

export const isT3 = (where: string) => /^T3 Code\b/.test(where);

/** A Claude Code session's transcript, for peeking at a thread that isn't running. */
export function claudeTranscript(session: string, cwd?: string, env = process.env): string | undefined {
	const root = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
	const direct = cwd && join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${session}.jsonl`);
	if (direct && existsSync(direct)) return direct;
	try {
		for (const dir of readdirSync(root)) {
			const p = join(root, dir, `${session}.jsonl`);
			if (existsSync(p)) return p;
		}
	} catch {}
	return undefined;
}
