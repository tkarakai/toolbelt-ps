process.env.TOOLBELT_PLUGIN = "processes";
process.env.TOOLBELT_PLUGIN_VERSION = "0.0.1";
// T3 Code threads: matching live agents, listing open threads that have no process.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcRow, Snapshot } from "../src/core";
import { build, facetCounts, threadOfRow } from "../src/model";
import { claudeTranscript, readT3Threads, threadOf, toThreads, type T3Thread } from "../src/t3code";
import type { Cell, Row } from "@toolbelt/sdk";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const thread = (p: Partial<T3Thread> & { id: string }): T3Thread => ({ title: `Thread ${p.id}`, harness: "claude", sessions: [], state: "idle", lastActive: NOW - 3_600_000, open: true, ...p });
const job = (p: Partial<ProcRow> & { pid: number }): ProcRow => ({
	kind: "daemon", command: "claude", argvCommand: "claude", displayArgv: [], source: "argv", leaderGone: false, cwd: "/w/a", listen: [], where: "T3 Code (Beta)",
	tty: "", stat: "S", etimeSec: 100, rssKb: 1024, cpu: 0, pidCount: 1, members: [], termLabel: "", shellAlive: true, ...p,
});
const snap = (rows: ProcRow[]): Snapshot => ({ at: 0, rows, kept: [], probes: [], branches: {}, sort: { key: "started", desc: true } });
const opts = { query: "", showAll: false, sort: "started" as const, desc: true, now: NOW };
const labels = (r: Row) => (r.group as { label: string }[] | undefined)?.map((g) => g.label);

describe("reading T3 Code's database", () => {
	test("threads, their sessions, state and sidebar visibility", () => {
		const threads = toThreads(
			[
				{ id: "a", title: "Open", provider: "claudeAgent", updatedAt: "2026-11-15T10:00:00Z", active: "pa", worktree: "/w/a", branch: "feat/a", settledAt: null, snoozedUntil: null, relation: null, project: "proj", root: "/w", run: "running", lastRunAt: "2026-11-15T11:00:00Z", pending: 0 },
				{ id: "b", title: "Asks", provider: "codex", updatedAt: "2026-11-15T10:00:00Z", active: null, worktree: null, branch: null, settledAt: null, snoozedUntil: "2026-11-16T09:00:00Z", relation: null, project: "proj", root: "/w", run: "completed", lastRunAt: null, pending: 1 },
				{ id: "c", title: "Done", provider: "claudeAgent", updatedAt: "2026-11-15T10:00:00Z", active: null, worktree: "/w/c", branch: null, settledAt: "2026-11-15T10:00:00Z", snoozedUntil: null, relation: null, project: null, root: null, run: "completed", lastRunAt: null, pending: 0 },
				{ id: "d", title: "Sub", provider: "claudeAgent", updatedAt: "2026-11-15T10:00:00Z", active: null, worktree: "/w/d", branch: null, settledAt: null, snoozedUntil: null, relation: "subagent", project: null, root: null, run: null, lastRunAt: null, pending: 0 },
			],
			[
				{ threadId: "a", id: "old", nativeId: "s-old" },
				{ threadId: "a", id: "pa", nativeId: "s-a" },
				{ threadId: "a", id: "pending", nativeId: "pending:run:thread:a:ordinal:1" },
			],
			NOW,
		);
		expect(threads.map((t) => [t.id, t.harness, t.state, t.open])).toEqual([["a", "claude", "working", true], ["b", "codex", "waiting", true], ["c", "claude", "idle", false], ["d", "claude", "idle", false]]);
		expect(threads[0]).toMatchObject({ sessions: ["s-old", "s-a"], session: "s-a", cwd: "/w/a", branch: "feat/a", lastActive: Date.parse("2026-11-15T11:00:00Z") });
		expect(threads[1]).toMatchObject({ cwd: "/w", snoozedUntil: Date.parse("2026-11-16T09:00:00Z") });
	});

	test("a missing or unrecognized database means no threads", () => {
		const dir = mkdtempSync(join(tmpdir(), "t3-"));
		expect(readT3Threads(join(dir, "nope.sqlite"))).toEqual([]);
		const path = join(dir, "other.sqlite");
		new Database(path).run("create table unrelated (x)");
		expect(readT3Threads(path)).toEqual([]);
	});
});

describe("live agents", () => {
	test("match by session id, else (inside T3 Code) by folder", () => {
		const threads = [thread({ id: "a", sessions: ["s-a"], cwd: "/w/a" }), thread({ id: "b", cwd: "/w/b" })];
		expect(threadOf(job({ pid: 1, agent: { harness: "claude", sessionId: "s-a" }, where: "Ghostty" }), threads)?.id).toBe("a");
		expect(threadOf(job({ pid: 2, cwd: "/w/b", agent: { harness: "claude" } }), threads)?.id).toBe("b");
		expect(threadOf(job({ pid: 3, cwd: "/w/b", agent: { harness: "claude" }, where: "Ghostty" }), threads)).toBeUndefined();
		expect(threadOf(job({ pid: 4, cwd: "/w/b", agent: { harness: "codex" } }), threads)).toBeUndefined();
	});
});

describe("threads without a process", () => {
	const live = job({ pid: 10, cwd: "/w/a", agent: { harness: "claude", title: "Live one", status: "working" }, t3: { id: "live", title: "Live one", state: "working" } });
	const t3 = [
		thread({ id: "live" }),
		thread({ id: "same-folder", title: "Paused work", cwd: "/w/a", branch: "feat/x", session: "s-1", project: "proj" }),
		thread({ id: "elsewhere", title: "Elsewhere", cwd: "/w/z", harness: "codex", snoozedUntil: NOW + 86_400_000, lastActive: NOW - 60_000 }),
		thread({ id: "settled", open: false }),
	];

	test("grouped: under T3 Code's section and their folder, after its running jobs", () => {
		const rows = build(snap([live]), { ...opts, t3 }).rows;
		expect(rows.map((r) => r.id)).toEqual(["10", "t3:same-folder", "t3:elsewhere"]);
		expect(labels(rows[1]!)).toEqual(["T3 Code (Beta)", "/w/a"]);
		expect(labels(rows[2]!)).toEqual(["T3 Code (Beta)", "/w/z"]);
		expect(rows[1]!.group).toEqual(rows[0]!.group);
		const name = (rows[1]!.cells as Record<string, Cell>).name as { text: string; sub: string; tags: { text: string }[] };
		expect(name).toMatchObject({ text: "Paused work", sub: "proj · last active 1h 0m ago" });
		expect(name.tags.map((t) => t.text)).toEqual(["Claude Code", "not running"]);
		expect(rows[1]!.actions).toEqual(["t3-open", "output"]);
		expect(rows[2]!.actions).toEqual(["t3-open"]);
		expect(((rows[2]!.cells as Record<string, Cell>).name as { sub: string }).sub).toContain("snoozed until");
	});

	test("with no T3 Code process running, they get a T3 Code section of their own", () => {
		const rows = build(snap([job({ pid: 1, where: "Ghostty", agent: undefined })]), { ...opts, t3 }).rows;
		expect(rows.slice(1).map((r) => labels(r)![0])).toEqual(["T3 Code", "T3 Code", "T3 Code"]);
	});

	test("flat: at the end, most recently active first, with folder and branch cells", () => {
		const rows = build(snap([live]), { ...opts, t3, view: "flat" }).rows;
		expect(rows.map((r) => r.id)).toEqual(["10", "t3:elsewhere", "t3:same-folder"]);
		expect((rows[2]!.cells as Record<string, Cell>).branch).toMatchObject({ text: "feat/x" });
	});

	test("search and filters apply, and the State filter counts them as not running", () => {
		expect(build(snap([live]), { ...opts, t3, query: "elsewhere" }).rows.map((r) => r.id)).toEqual(["t3:elsewhere"]);
		expect(build(snap([live]), { ...opts, t3, filters: { agent: ["codex"] } }).rows.map((r) => r.id)).toEqual(["t3:elsewhere"]);
		expect(build(snap([live]), { ...opts, t3, filters: { service: ["agent-busy"] } }).rows.map((r) => r.id)).toEqual(["10"]);
		expect(facetCounts(snap([live]), { ...opts, t3 }).service.get("agent-stopped")).toBe(2);
		expect(threadOfRow({ t3 }, "t3:elsewhere")?.title).toBe("Elsewhere");
		expect(threadOfRow({ t3 }, "10")).toBeUndefined();
	});
});

test("a Claude Code transcript is found by session, in its folder's project or any other", () => {
	const home = mkdtempSync(join(tmpdir(), "claude-"));
	mkdirSync(join(home, "projects", "-w-a"), { recursive: true });
	mkdirSync(join(home, "projects", "-elsewhere"), { recursive: true });
	writeFileSync(join(home, "projects", "-w-a", "s-1.jsonl"), "");
	writeFileSync(join(home, "projects", "-elsewhere", "s-2.jsonl"), "");
	const env = { CLAUDE_CONFIG_DIR: home };
	expect(claudeTranscript("s-1", "/w/a", env)).toBe(join(home, "projects", "-w-a", "s-1.jsonl"));
	expect(claudeTranscript("s-2", "/w/a", env)).toBe(join(home, "projects", "-elsewhere", "s-2.jsonl"));
	expect(claudeTranscript("s-3", "/w/a", env)).toBeUndefined();
});
