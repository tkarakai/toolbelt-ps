import { asset } from "@toolbelt/sdk";
// How the process list is organized — a port of running's (src/ui/App.tsx, and
// mac/…/Model/Grouping.swift): sections by where jobs run (terminal app, tmux pane, detached),
// then the folder each job was started in (with its git branch), then jobs. A job's processes,
// and jobs started from it, nest under it. Sorting applies at every level. Pure functions, so
// test/processes-model.test.ts can check them.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { DetailItem, Dot, Hue, Row, Tag, Target, Tone } from "@toolbelt/sdk";
import { search, type Search } from "@toolbelt/sdk/search";
import { agentById, detectAgent, type AgentKind } from "./agents";
import type { Agent, Listen, Member, ProcRow, Snapshot, SortKey } from "./core";

const home = homedir();
export const tildify = (p: string) => (p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
export const dur = (s: number) =>
	s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
export const mem = (kb: number) => (kb > 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);
export const displayName = (r: ProcRow) => r.agent?.title || r.command || r.argvCommand;
export const sectionLabel = (where: string) => (where === "detached" ? "Detached" : where || "Unknown");

/** "working", "idle 12m" — like running's agent rows. `lastActive` is epoch ms (or s). */
export function agentState(a: Agent, now = Date.now()) {
	if (a.status === "working") return "working";
	if (a.status === "new") return "new";
	if (!a.lastActive) return "idle";
	const ms = a.lastActive > 1e12 ? a.lastActive : a.lastActive * 1000;
	return `idle ${dur(Math.max(0, (now - ms) / 1000))}`;
}
/**
 * The part of a path that names the project: the folder after a collection of projects
 * ("toolbelt" in ~/dev/projects/toolbelt/src and ~/worktrees/toolbelt/t3-1234), else the last
 * folder.
 * Collections can nest (~/dev/projects/…): the project is after the innermost one in a row.
 */
export const COLLECTIONS = new Set(["workspaces", "workspace", "projects", "project", "worktrees", "worktree", "repos", "repo", "repositories", "code", "dev", "developer", "development", "git", "github", "gitlab", "sites", "work", "clones", "checkouts", "sandbox", "playground", "experiments", "src"]);
export function projectPart(path: string): string | undefined {
	const parts = path.split("/").filter((p) => p && p !== "~");
	for (let i = 0; i < parts.length - 1; i++) {
		if (!COLLECTIONS.has(parts[i].toLowerCase())) continue;
		if (COLLECTIONS.has(parts[i + 1].toLowerCase()) && i + 2 < parts.length) continue; // nested: look further
		return parts[i + 1];
	}
	return parts.at(-1);
}

/** Heavy use, worth noticing: CPU % (100 = one core busy) and resident memory (KB). */
export const cpuTone = (cpu: number): Tone => (cpu >= 100 ? "danger" : cpu >= 50 ? "warning" : "default");
export const memTone = (kb: number): Tone => (kb >= 4 * 1024 * 1024 ? "danger" : kb >= 1024 * 1024 ? "warning" : "default");

/** paused / zombie / waiting on disk, from ps's STAT. */
export const stateLabel = (stat: string) => (stat.includes("Z") ? "zombie" : stat.includes("T") ? "paused" : stat.startsWith("D") ? "waiting on disk" : "");

/** The app bundle an executable lives in (the outermost `.app`), if any. */
export const bundleOf = (exe?: string) => exe?.match(/^(.*?\.app)(\/|$)/)?.[1];

const KNOWN_APPS = ["/Applications", "/System/Applications", "/System/Applications/Utilities", `${home}/Applications`];
const appByName = new Map<string, string | undefined>();
/** Where an app called `name` is installed (cached), for terminal sections' icons. */
export function findApp(name: string): string | undefined {
	if (!appByName.has(name)) appByName.set(name, KNOWN_APPS.map((d) => `${d}/${name}.app`).find((p) => existsSync(p)));
	return appByName.get(name);
}

/** The icon for a section: the app it is (or runs in), else a symbol. */
function sectionIcon(where: string, rows: ProcRow[], isApp: boolean, all: ProcRow[]): string {
	if (where === "detached") return "unplug";
	if (where.startsWith("tmux")) return "columns-2";
	if (where === "macOS") return "apple";
	const bundle =
		rows.map((r) => bundleOf(r.exe)).find(Boolean) ??
		all.filter((r) => r.where === where && r.kind === "app").map((r) => bundleOf(r.exe)).find(Boolean) ??
		findApp(where.split(" · ")[0]);
	if (bundle) return `app:${bundle}`;
	return isApp ? "app-window" : "square-terminal";
}

/** Table column ↔ running's sort key. */
export const COLUMN_SORT: Record<string, SortKey> = { name: "name", cpu: "cpu", mem: "memory", uptime: "started" };
export const SORT_COLUMN: Record<SortKey, string> = { name: "name", cpu: "cpu", memory: "mem", started: "uptime" };

const KIND_RANK: Record<string, number> = { job: 0, term: 0, server: 1, daemon: 2, app: 3 };

type Val = number | string;
export type Options = {
	query: string;
	/** Show app and system servers (running hides them until `a`). */
	showAll: boolean;
	sort: SortKey;
	desc: boolean;
	/** Recent CPU % and memory KB per pid, oldest first, for sparklines. */
	history?: Map<number, { cpu: number[]; mem: number[] }>;
	now?: number;
	/** Checked filter values (none checked: everything). See `FILTERS`. */
	filters?: Partial<Record<FilterId, string[]>>;
	/** Whether an agent is waiting for the person (Claude Code's live status). */
	waiting?: (pid: number) => boolean;
};

// ── what a process is and how it's doing ─────────────────────────────────
/** Which agent a job is: running-core's harness, else recognized from its command line. */
export function agentOf(r: { displayArgv: string[]; exe?: string; agent?: Agent }): AgentKind | undefined {
	return (r.agent && agentById(r.agent.harness)) ?? detectAgent(r.displayArgv, r.exe);
}

/** How a process is doing. Agents: working / waiting for you / idle / new; anything: paused,
 *  zombie, waiting on disk, or just running. */
export type Activity = "working" | "waiting" | "idle" | "new" | "paused" | "zombie" | "disk" | "running";
export const ACTIVITY: Record<Activity, { label: string; color: Tone | Hue }> = {
	working: { label: "Working", color: "green" },
	waiting: { label: "Waiting for you", color: "red" },
	idle: { label: "Idle", color: "muted" },
	new: { label: "New", color: "info" },
	paused: { label: "Paused", color: "warning" },
	zombie: { label: "Zombie", color: "danger" },
	disk: { label: "Waiting on disk", color: "orange" },
	running: { label: "Running", color: "slate" },
};

/** Agents running-core doesn't know in depth count as working while they use the CPU. */
const BUSY_CPU = 3;

export function activity(r: { stat: string; cpu: number; pid: number; agent?: Agent }, isAgent: boolean, o: Pick<Options, "waiting"> = {}): Activity {
	const st = stateLabel(r.stat);
	if (st === "zombie") return "zombie";
	if (st === "paused") return "paused";
	if (st === "waiting on disk") return "disk";
	if (!isAgent) return "running";
	if (o.waiting?.(r.pid)) return "waiting";
	if (r.agent?.status) return r.agent.status === "working" ? "working" : r.agent.status === "new" ? "new" : "idle";
	return r.cpu >= BUSY_CPU ? "working" : "idle";
}

/** What its dot says: a web server, something else listening, an agent (busy / idle / waiting
 *  for you), a process in trouble (paused, zombie), or just a process. */
export type Service = "web" | "port" | "agent-busy" | "agent-idle" | "agent-waiting" | "paused" | "zombie" | "disk" | "agent-new" | "plain";
export const SERVICE: Record<Service, { label: string; dot: Exclude<Dot, string> }> = {
	"agent-busy": { label: "Agent working", dot: { color: "green", pulse: true } },
	"agent-waiting": { label: "Agent waiting for you", dot: { color: "fuchsia", pulse: true } },
	"agent-idle": { label: "Agent idle", dot: { color: "green", dim: true } },
	web: { label: "Web server", dot: { color: "blue" } },
	port: { label: "Listening (not web)", dot: { color: "violet" } },
	paused: { label: "Paused", dot: { color: "amber" } },
    zombie: { label: "Zombie", dot: { color: "red" } },
    disk: { label: "Waiting on disk", dot: { color: "amber" } },
    "agent-new": { label: "Agent new session", dot: { color: "green", dim: true } },
	plain: { label: "Other processes", dot: { color: "muted" } },
};

export function service(snap: Snapshot, r: { listen: Listen[] }, act: Activity, isAgent: boolean): Service {
	if (act === "paused" || act === "zombie" || act === "disk") return act;
	if (isAgent) return act === "working" ? "agent-busy" : act === "waiting" ? "agent-waiting" : act === "new" ? "agent-new" : "agent-idle";
	if (webUrl(snap, r)) return "web";
	return r.listen.length ? "port" : "plain";
}

/** The dot, with what it means in words (its tooltip). */
export function dotFor(snap: Snapshot, r: { listen: Listen[]; agent?: Agent }, act: Activity, svc: Service, agent: AgentKind | undefined, now?: number): Dot {
	const ports = r.listen.map((l) => `:${l.port}`).join(" ");
	const who = agent?.name ?? "Agent";
	const label =
		svc === "web" ? `Web server — ${webUrl(snap, r)}`
		: svc === "port" ? `Listening on ${ports} — not a web page`
		: svc === "agent-busy" ? `${who} is working${r.agent?.status ? "" : " (it's using the CPU)"}`
		: svc === "agent-waiting" ? `${who} is waiting for you`
		: svc === "agent-idle" ? (act === "new" ? `${who} — no conversation yet` : `${who} is ${r.agent ? agentState(r.agent, now) : "idle"}`)
		: svc === "agent-new" ? `${who} — no conversation yet`
        : ["paused", "zombie", "disk"].includes(svc) ? (act === "paused" ? "Paused (stopped with ⌃Z or SIGSTOP)" : act === "zombie" ? "Zombie — it exited, but its parent hasn't collected it" : "Waiting on the disk")
		: "Running";
	return { ...SERVICE[svc].dot, label };
}

// ── filters ──────────────────────────────────────────────────────────────
export type FilterId = "agent" | "service";
/** The filters, in toolbar order. Agent `none`: processes that aren't agents. */
export const FILTERS: { id: FilterId; label: string; icon: string }[] = [
	{ id: "agent", label: "Agent", icon: "bot" },
	{ id: "service", label: "State", icon: "circle-dot" },
];

/** A job's value for each filter. */
export function facetsOf(snap: Snapshot, r: ProcRow, o: Pick<Options, "waiting">): Record<FilterId, string> {
	const agent = agentOf(r);
	const act = activity(r, !!agent, o);
	return { agent: agent?.id ?? "none", service: service(snap, r, act, !!agent) };
}

const passes = (f: Record<FilterId, string>, filters: Options["filters"]) => (Object.keys(f) as FilterId[]).every((k) => !filters?.[k]?.length || filters[k]!.includes(f[k]));

/** How many jobs have each value, among those the other filters let through — so a count says
 *  what checking it would add. */
export function facetCounts(snap: Snapshot, o: Options): Record<FilterId, Map<string, number>> {
	const s = search(o.query);
	const out: Record<FilterId, Map<string, number>> = { agent: new Map(), service: new Map() };
	for (const r of snap.rows) {
		if (!(o.showAll || r.kind !== "app") || !s.test(searchable(snap, r))) continue;
		const f = facetsOf(snap, r, o);
		for (const k of Object.keys(out) as FilterId[]) {
			if (!passes(f, { ...o.filters, [k]: [] })) continue;
			out[k].set(f[k], (out[k].get(f[k]) ?? 0) + 1);
		}
	}
	return out;
}

export type Built = {
	rows: Row[];
	search: Search;
	/** Jobs shown, of the jobs there are. */
	shown: number;
	total: number;
	/** App/system jobs left out (showAll off). */
	hiddenApps: number;
};

export function webUrl(snap: Snapshot, r: { listen: Listen[] }) {
	return snap.probes.find((p) => p.web && r.listen.some((l) => l.pid === p.pid && l.port === p.port))?.url;
}
const probeTitles = (snap: Snapshot, r: { listen: Listen[] }) => snap.probes.filter((p) => p.title && r.listen.some((l) => l.pid === p.pid && l.port === p.port)).map((p) => p.title!);

/** Everything a person might type to find a job. */
export function searchable(snap: Snapshot, r: ProcRow): (string | number | undefined)[] {
	const a = r.agent;
	const keptName = r.keptIndex !== undefined ? snap.kept.find((k) => k.index === r.keptIndex)?.name : undefined;
	return [
		displayName(r), r.command, r.argvCommand, r.cwd, tildify(r.cwd), r.pid, r.kind, sectionLabel(r.where), r.termLabel, r.cmux?.workspace, r.cmux?.surface, r.tty, r.exe, stateLabel(r.stat), keptName,
		...r.listen.flatMap((l) => [`:${l.port}`, l.host]),
		snap.branches[r.cwd] ?? undefined, webUrl(snap, r), ...probeTitles(snap, r),
		a?.harness, a?.title, a?.model, a && agentState(a), a?.branch, a?.sessionId,
		...r.members.flatMap(memberSearchable),
	];
}
const memberSearchable = (m: Member) => [m.pid, m.argvCommand, tildify(m.cwd), ...m.listen.map((l) => `:${l.port}`)];

/** A job's dot (the popover's quick view uses it too). */
export function statusDot(snap: Snapshot, r: ProcRow, o: Pick<Options, "waiting" | "now"> = {}): Dot {
	const agent = agentOf(r);
	const act = activity(r, !!agent, o);
	return dotFor(snap, r, act, service(snap, r, act, !!agent), agent, o.now);
}

export function build(snap: Snapshot, o: Options): Built {
	const s = search(o.query);
	const sign = o.desc ? -1 : 1;
	const cmp = (a: Val, b: Val) => sign * (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));
	const jobVal = (j: ProcRow): Val => (o.sort === "started" ? j.etimeSec : o.sort === "memory" ? j.rssKb : o.sort === "cpu" ? j.cpu : displayName(j).toLowerCase());
	const memberVal = (m: Member): Val => (o.sort === "started" ? m.etimeSec : o.sort === "memory" ? m.rssKb : o.sort === "cpu" ? m.cpu : m.argvCommand.toLowerCase());
	const rankGroups = o.sort === "memory" || o.sort === "cpu";
	const groupVal = (js: ProcRow[], label: string): Val => (
        o.sort === "memory" ? js.reduce((largest, j) => Math.max(largest, j.rssKb), 0)
        : o.sort === "cpu" ? js.reduce((total, j) => total + j.cpu, 0) : label
    );
    // A job's RSS already includes its ordinary members. Nested jobs are disjoint
    // rows in running-core, so add those rows once, never their expanded members.
    const memorySummary = (jobs: ProcRow[]) => ({
        label: "Memory total (RSS)",
        value: `Σ ${mem(jobs.reduce((total, j) => total + j.rssKb, 0))}`,
        description: "Combined resident memory of the matching commands in this group, including their child processes. Shared memory may be counted by more than one process. Collapsing the group does not change this total.",
    });
	const byKey = (a: ProcRow, b: ProcRow) => cmp(jobVal(a), jobVal(b)) || a.pid - b.pid;

	const all = snap.rows;
	const apps = all.filter((r) => r.kind === "app");
	const visible = all.filter((r) => (o.showAll || r.kind !== "app") && s.test(searchable(snap, r)) && passes(facetsOf(snap, r, o), o.filters));

	// Sections: by where, terminals before servers before apps, then by name (or the largest command for memory sorting).
	const sections = new Map<string, ProcRow[]>();
	for (const j of visible) { const where = j.where.startsWith("tmux") ? "tmux" : j.where; sections.set(where, [...(sections.get(where) ?? []), j]); }
	const rank = (js: ProcRow[]) => Math.min(...js.map((j) => KIND_RANK[j.kind] ?? 9));
	let ordered = [...sections.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || sectionLabel(a[0]).localeCompare(sectionLabel(b[0])));
	if (rankGroups) ordered = ordered.sort((a, b) => cmp(groupVal(a[1], a[0]), groupVal(b[1], b[0])));

	const rows: Row[] = [];
	for (const [where, js] of ordered) {
		const isApp = js.every((j) => j.kind === "app");
		const section = {
			id: `w:${where}`,
			label: where === "tmux" ? "TMUX" : sectionLabel(where),
			tag: where === "detached" ? "no terminal" : isApp ? "app" : undefined,
			muted: isApp,
			icon: sectionIcon(where, js, isApp, all),
            summary: memorySummary(js),
		};
		const pids = new Set(js.map((j) => j.pid));
		const roots = js.filter((j) => j.parentRow === undefined || !pids.has(j.parentRow));
        const childJobsByParent = new Map<number, ProcRow[]>();
        for (const job of js) if (job.parentRow !== undefined) childJobsByParent.set(job.parentRow, [...(childJobsByParent.get(job.parentRow) ?? []), job]);
        const jobsUnder = (roots: ProcRow[]) => {
            const jobs: ProcRow[] = [], seen = new Set<number>(), pending = [...roots];
            while (pending.length) {
                const job = pending.pop()!;
                if (seen.has(job.pid)) continue;
                seen.add(job.pid); jobs.push(job);
                pending.push(...(childJobsByParent.get(job.pid) ?? []));
            }
            return jobs;
        };
		const dirs = new Map<string, ProcRow[]>();
		for (const j of roots) dirs.set(j.cwd, [...(dirs.get(j.cwd) ?? []), j]);
		const directoryJobs = new Map([...dirs.entries()].map(([dir, roots]) => [dir, jobsUnder(roots)]));
        const dirRank = ([dir, roots]: [string, ProcRow[]]) => groupVal(o.sort === "memory" ? directoryJobs.get(dir)! : roots, dir);
        const dirList = [...dirs.entries()].sort((a, b) => (rankGroups ? cmp(dirRank(a), dirRank(b)) : tildify(a[0]).localeCompare(tildify(b[0]), undefined, { numeric: true })));
		for (const [dir, djs] of dirList) {
			const branch = dir && dir !== "/" ? (snap.branches[dir] ?? undefined) : undefined;
			const group = [section, { id: `d:${where}:${dir}`, label: tildify(dir) || "—", strong: dir && dir !== "/" ? projectPart(tildify(dir)) : undefined, sub: branch ?? undefined, summary: memorySummary(directoryJobs.get(dir)!) }];
			const place = (j: ProcRow): Row => {
				const childJobs = [...(childJobsByParent.get(j.pid) ?? [])].sort(byKey);
				const members = sortTree(j.members, memberVal, cmp).map((m) => memberRow(snap, j, m, o));
				// Expanded when jobs were started from it, or the search matched one of its processes.
				const memberHit = !s.empty && j.members.some((m) => s.test(memberSearchable(m)));
				const children = [...nestMembers(j, members), ...childJobs.map(place)];
				return { ...jobRow(snap, j, o, childJobs), children: children.length ? children : undefined, open: childJobs.length > 0 || memberHit || undefined };
			};
			for (const j of djs.sort(byKey)) rows.push({ ...place(j), group });
		}
	}
	return { rows, search: s, shown: visible.length, total: all.length, hiddenApps: o.showAll ? 0 : apps.length };
}

/** Siblings follow the sort; parents stay above their children. Flat, parent first. */
export function sortTree(members: Member[], value: (m: Member) => Val, cmp: (a: Val, b: Val) => number): Member[] {
	const pids = new Set(members.map((m) => m.pid));
	const kids = new Map<number, Member[]>();
	const tops: Member[] = [];
	for (const m of members) (pids.has(m.ppid) ? kids.set(m.ppid, [...(kids.get(m.ppid) ?? []), m]) : tops.push(m));
	const out: Member[] = [];
	const walk = (list: Member[]) => {
		for (const m of list.sort((a, b) => cmp(value(a), value(b)) || a.pid - b.pid)) {
			out.push(m);
			walk(kids.get(m.pid) ?? []);
		}
	};
	walk(tops);
	return out;
}

/** Member rows (flat, sorted) into a tree by parent pid. */
function nestMembers(job: ProcRow, flat: Row[]): Row[] {
	const byPid = new Map(job.members.map((m) => [String(m.pid), m]));
	const rows = new Map(flat.map((r) => [r.id, { ...r, children: [] as Row[] }]));
	const tops: Row[] = [];
	for (const r of flat) {
		const m = byPid.get(r.id)!;
		const parent = rows.get(String(m.ppid));
		(parent ? parent.children : tops).push(rows.get(r.id)!);
	}
	const clean = (r: Row & { children: Row[] }): Row => ({ ...r, children: r.children.length ? r.children.map((c) => clean(c as Row & { children: Row[] })) : undefined });
	return tops.map((r) => clean(r as Row & { children: Row[] }));
}

const spark = (o: Options, pid: number, key: "cpu" | "mem") => {
	const h = o.history?.get(pid)?.[key];
	return h && h.length > 1 ? h : undefined;
};

/** The pills on a job's second line: which agent, and how it (or any process) is doing. */
function tagsFor(r: ProcRow, agent: AgentKind | undefined, act: Activity, o: Options): Tag[] {
	const tags: Tag[] = [];
	if (agent) tags.push({ text: agent.name, color: agent.hue, icon: asset(`agent-${agent.id}`) });
	if (act !== "running") {
		const text = act === "idle" && r.agent ? agentState(r.agent, o.now) : ACTIVITY[act].label.toLowerCase();
		tags.push({ text, color: ACTIVITY[act].color });
	}
	return tags;
}

/** Where an action could go, for a job with processes of its own: the job, the processes it
 *  started (and jobs started from it). Only listed when there's more than one. */
function targetsFor(snap: Snapshot, r: ProcRow, childJobs: ProcRow[]): Row["targets"] {
	const procs: { pid: number; label: string; cwd: string; listen: Listen[]; tty?: string }[] = [
		{ pid: r.pid, label: displayName(r), cwd: r.cwd, listen: r.listen.filter((l) => l.pid === r.pid), tty: r.tty },
		...r.members.map((m) => ({ pid: m.pid, label: m.argvCommand, cwd: m.cwd, listen: m.listen })),
		...childJobs.map((c) => ({ pid: c.pid, label: displayName(c), cwd: c.cwd, listen: c.listen, tty: c.tty })),
	];
	const sub = (p: (typeof procs)[number]) => [`pid ${p.pid}`, ...p.listen.map((l) => `:${l.port}`)].join(" · ");
	const peek: Target[] = procs.map((p) => ({ id: String(p.pid), label: p.label, sub: sub(p), icon: p.pid === r.pid ? "square-terminal" : "corner-down-right" }));
	// Its own terminal, and the terminals of jobs started from it.
	const jump: Target[] = [r, ...childJobs].filter((j) => j.tty).map((j) => ({ id: String(j.pid), label: displayName(j), sub: `${j.termLabel || j.tty} · pid ${j.pid}`, icon: "square-terminal" }));
	const open: Target[] = snap.probes
		.filter((p) => p.web && p.url && [...r.listen, ...childJobs.flatMap((c) => c.listen)].some((l) => l.pid === p.pid && l.port === p.port))
		.map((p) => ({ id: p.url!, label: p.url!, sub: [p.title, `pid ${p.pid}`].filter(Boolean).join(" · "), icon: "globe" }));
	return { output: peek, focus: jump, open };
}

/**
 * "Started processes": a job's processes and the jobs started from it, those with ports first
 * (web pages apart from other listeners), each with Peek and — for web pages — Open.
 */
function startedSection(snap: Snapshot, r: ProcRow, childJobs: ProcRow[]): DetailItem[] {
	const S = "Started processes";
	const all = [...r.members.map((m) => ({ pid: m.pid, command: m.argvCommand, listen: m.listen, stat: m.stat })), ...childJobs.map((c) => ({ pid: c.pid, command: displayName(c), listen: c.listen, stat: c.stat }))];
	if (!all.length) return [];
	const kind = (p: (typeof all)[number]) => (webUrl(snap, p) ? 0 : p.listen.length ? 1 : 2);
	const sorted = [...all].sort((a, b) => kind(a) - kind(b) || a.pid - b.pid);
	const LIMIT = 12;
	const items: DetailItem[] = sorted.slice(0, LIMIT).map((p) => {
		const url = webUrl(snap, p);
		const ports = p.listen.map((l) => `:${l.port}`).join(" ");
		const st = stateLabel(p.stat);
		return {
			section: S,
			label: [url ? `web ${ports}` : ports ? `port ${ports}` : "", `pid ${p.pid}`, st].filter(Boolean).join(" · "),
			value: p.command,
			mono: true,
			dot: url ? { color: "blue", label: url } : ports ? { color: "violet", label: `Listening on ${ports} — not a web page` } : st ? "amber" : "muted",
			actionRow: String(p.pid),
			actions: [{ id: "output", label: "Peek", icon: "scan-eye" }, ...(url ? [{ id: "open", label: `Open ${url}`, icon: "globe" }] : [])],
		};
	});
	const web = all.filter((p) => webUrl(snap, p)).length, ports = all.filter((p) => p.listen.length && !webUrl(snap, p)).length;
	const summary = [`${all.length} in all`, web ? `${web} web` : "", ports ? `${ports} listening` : ""].filter(Boolean).join(" · ");
	return [{ section: S, label: "Summary", value: summary }, ...items, ...(all.length > LIMIT ? [{ section: S, label: "More", value: `and ${all.length - LIMIT} more — expand the row to see them all` }] : [])];
}

function jobRow(snap: Snapshot, r: ProcRow, o: Options, childJobs: ProcRow[] = []): Row {
	const a = r.agent;
	const agent = agentOf(r);
	const act = activity(r, !!agent, o);
	const svc = service(snap, r, act, !!agent);
	const url = webUrl(snap, r);
	const kept = r.keptIndex !== undefined ? snap.kept.find((k) => k.index === r.keptIndex) : undefined;
	const titles = probeTitles(snap, r);
	const sub = [
		r.cmux ? `CMUX · ${r.cmux.workspace} / ${r.cmux.surface}` : r.where.startsWith("tmux ") ? r.where.slice(5) : "",
		agent ? "" : r.kind,
		r.leaderGone ? `launcher exited · ${r.pidCount} left running` : r.pidCount > 1 ? `${r.pidCount} processes` : "",
		r.source === "history" ? "command guessed from history" : "",
	].filter(Boolean).join(" · ");
	const branch = snap.branches[r.cwd];
	const bundle = r.kind === "app" ? bundleOf(r.exe) : undefined;
	const P = "Process", C = "Command", N = "Network", A = "Agent";
	return {
		id: String(r.pid),
		cells: {
			name: {
				text: (r.leaderGone ? "⤷ " : "") + displayName(r),
				sub,
				tags: tagsFor(r, agent, act, o),
				marks: kept ? [{ icon: "bookmark", tooltip: `A running instance of the kept command “${kept.name ?? kept.command}”`, color: "amber" }] : undefined,
				...(bundle ? { icon: `app:${bundle}` } : { dot: dotFor(snap, r, act, svc, agent, o.now) }),
				mono: !a && !bundle,
			},
			ports: { text: "", chips: r.listen.map((l) => `:${l.port}`) },
			cpu: { text: `${r.cpu.toFixed(1)}%`, spark: spark(o, r.pid, "cpu"), mono: true, tone: cpuTone(r.cpu) },
			mem: { text: mem(r.rssKb), spark: spark(o, r.pid, "mem"), mono: true, tone: memTone(r.rssKb) },
			uptime: dur(r.etimeSec),
		},
		actions: ["focus", "output", ...(url || childJobs.some((c) => webUrl(snap, c)) ? ["open"] : []), ...(stateLabel(r.stat) ? ["why"] : []), kept ? "edit-kept" : "keep", "copy", "restart", "stop", "kill"],
		targets: targetsFor(snap, r, childJobs),
		stats: [
			{ label: "CPU", value: `${r.cpu.toFixed(1)}%`, spark: spark(o, r.pid, "cpu"), tone: cpuTone(r.cpu) },
			{ label: "Memory", value: mem(r.rssKb), spark: spark(o, r.pid, "mem"), tone: memTone(r.rssKb) },
			{ label: "Up", value: dur(r.etimeSec) },
		],
		details: [
			{ section: C, label: "Command", value: r.command, mono: true },
			...(r.command !== r.argvCommand ? [{ section: C, label: "Running as", value: r.argvCommand, mono: true }] : []),
			{ section: C, label: "Directory", value: tildify(r.cwd), mono: true },
			...(branch ? [{ section: C, label: "Git branch", value: branch, mono: true }] : []),
			...(kept ? [{ section: C, label: "Kept as", value: kept.name ?? kept.command }] : []),
			...(url ? [{ section: N, label: "URL", value: url, mono: true }] : []),
			...(titles.length ? [{ section: N, label: "Page", value: titles.join(" · ") }] : []),
			...(a
				? [
						{ section: A, label: "Agent", value: [a.harness, a.model].filter(Boolean).join(" · ") },
						{ section: A, label: "Status", value: agentState(a, o.now) },
						...(a.tokens ? [{ section: A, label: "Tokens", value: a.tokens.toLocaleString() + (a.costUsd ? ` · $${a.costUsd.toFixed(2)}` : "") }] : []),
						...(a.branch ? [{ section: A, label: "Agent branch", value: a.branch, mono: true }] : []),
						...(a.resume ? [{ section: A, label: "Resume with", value: a.resume, mono: true }] : []),
					]
				: agent
					? [
							{ section: A, label: "Agent", value: agent.name },
							{ section: A, label: "Status", value: `${ACTIVITY[act].label}${act === "working" || act === "idle" ? " (from its CPU use)" : ""}` },
						]
					: []),
			...(r.cmux ? [{ section: P, label: "CMUX workspace", value: r.cmux.workspace }, { section: P, label: "CMUX surface", value: r.cmux.surface }] : []),
            { section: P, label: "Where", value: [sectionLabel(r.where), r.termLabel && r.termLabel !== r.where ? r.termLabel : ""].filter(Boolean).join(" · ") },
			{ section: P, label: "PID", value: `${r.pid}${r.pgid ? ` · group ${r.pgid}` : ""}`, mono: true, copy: false },
			...(r.tty ? [{ section: P, label: "TTY", value: r.tty, mono: true, copy: false }] : []),
			...(stateLabel(r.stat) ? [{ section: P, label: "State", value: stateLabel(r.stat), tone: "warning" as const }] : []),
			...(r.leaderGone ? [{ section: P, label: "Launcher", value: "exited — these processes were left running", tone: "warning" as const }] : []),
			...(bundle ? [{ section: P, label: "App", value: tildify(bundle), mono: true }] : []),
			...startedSection(snap, r, childJobs),
		],
	};
}

function memberRow(snap: Snapshot, job: ProcRow, m: Member, o: Options): Row {
	const url = webUrl(snap, m);
	const agent = agentOf(m);
	const act = activity(m, !!agent, o);
	const svc = service(snap, m, act, !!agent);
	return {
		id: String(m.pid),
		cells: {
			name: {
				text: m.argvCommand,
				sub: [`pid ${m.pid}`, m.pidCount > 1 ? `${m.pidCount} processes` : ""].filter(Boolean).join(" · "),
				tags: [...(agent ? [{ text: agent.name, color: agent.hue, icon: "bot" }] : []), ...(act !== "running" ? [{ text: ACTIVITY[act].label.toLowerCase(), color: ACTIVITY[act].color }] : [])],
				dot: dotFor(snap, m, act, svc, agent, o.now),
				mono: true,
			},
			ports: { text: "", chips: m.listen.map((l) => `:${l.port}`) },
			cpu: { text: `${m.cpu.toFixed(1)}%`, spark: spark(o, m.pid, "cpu"), mono: true, tone: cpuTone(m.cpu) },
			mem: { text: mem(m.rssKb), spark: spark(o, m.pid, "mem"), mono: true, tone: memTone(m.rssKb) },
			uptime: dur(m.etimeSec),
		},
		actions: ["output", ...(url ? ["open"] : []), ...(stateLabel(m.stat) ? ["why"] : []), "copy", "stop", "kill"],
		stats: [
			{ label: "CPU", value: `${m.cpu.toFixed(1)}%`, spark: spark(o, m.pid, "cpu"), tone: cpuTone(m.cpu) },
			{ label: "Memory", value: mem(m.rssKb), spark: spark(o, m.pid, "mem"), tone: memTone(m.rssKb) },
			{ label: "Up", value: dur(m.etimeSec) },
		],
		details: [
			{ section: "Command", label: "Command", value: m.argvCommand, mono: true },
			{ section: "Command", label: "Directory", value: tildify(m.cwd), mono: true },
			...(url ? [{ section: "Network", label: "URL", value: url, mono: true }] : []),
			{ section: "Process", label: "Part of", value: displayName(job) },
			{ section: "Process", label: "PID · parent", value: `${m.pid} · ${m.ppid}`, mono: true, copy: false },
			...(stateLabel(m.stat) ? [{ section: "Process", label: "State", value: stateLabel(m.stat), tone: "warning" as const }] : []),
		],
	};
}

/** The job a pid belongs to, and the member if it isn't the job itself. */
export function locate(snap: Snapshot | null, pid: number): { row: ProcRow; member?: Member } | undefined {
	for (const row of snap?.rows ?? []) {
		if (row.pid === pid) return { row };
		const member = row.members.find((m) => m.pid === pid);
		if (member) return { row, member };
	}
}

/** Strip terminal escape codes (colors, cursor moves) from output lines. */
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");

/** A peek source's name: the terminal, an agent's conversation, or a log file. */
export const sourceLabel = (s: string | undefined) => (s === undefined ? "Terminal" : s === "@transcript" ? "Conversation" : (s.split("/").pop() ?? s));
