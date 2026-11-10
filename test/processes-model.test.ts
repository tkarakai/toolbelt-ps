import type { GroupLabel } from "@toolbelt/sdk/protocol";
process.env.TOOLBELT_PLUGIN = "processes";
process.env.TOOLBELT_PLUGIN_VERSION = "0.0.1";
// The Processes plugin's list model: sections, folders, nesting, sorting, apps, search.
import { describe, expect, test } from "bun:test";
import type { ProcRow, Snapshot } from "../src/core";
import { AGENTS, detectAgent } from "../src/agents";
import { activity, agentState, facetsOf, SERVICE, build, facetCounts, projectPart, sortTree, statusDot, stripAnsi } from "../src/model";
import { HUES, type Cell, type Dot, type Row } from "@toolbelt/sdk";

const job = (p: Partial<ProcRow> & { pid: number }): ProcRow => ({
	kind: "term", command: `cmd${p.pid}`, argvCommand: `cmd${p.pid}`, displayArgv: [], source: "typed", leaderGone: false, cwd: "/w/a", listen: [], where: "Orca",
	tty: "", stat: "S", etimeSec: 100, rssKb: 1024, cpu: 0, pidCount: 1, members: [], termLabel: "", shellAlive: true, ...p,
});
const snap = (rows: ProcRow[], extra: Partial<Snapshot> = {}): Snapshot => ({ at: 0, rows, kept: [], probes: [], branches: {}, sort: { key: "started", desc: true }, ...extra });
const opts = { query: "", showAll: false, sort: "started" as const, desc: false };
const labels = (g: unknown) => (g as GroupLabel[]).map((l) => (typeof l === "string" ? l : l.label));

describe("grouping", () => {
	test("sections by where (terminals before apps, detached labelled), then folders with branch", () => {
		const s = snap(
			[job({ pid: 1, where: "detached", cwd: "/w/b" }), job({ pid: 2, where: "Orca" }), job({ pid: 3, where: "Code", kind: "app" }), job({ pid: 4, where: "Orca", cwd: "/w/b" })],
			{ branches: { "/w/a": "main" } },
		);
		const all = build(s, { ...opts, showAll: true }).rows;
		expect(all.map((r) => labels(r.group))).toEqual([
			["Detached", "/w/b"],
			["Orca", "/w/a"],
			["Orca", "/w/b"],
			["Code", "/w/a"],
		]);
		const g = all[0].group as Exclude<GroupLabel, string>[];
		expect(g[0].tag).toBe("no terminal");
		expect((all[1].group as Exclude<GroupLabel, string>[])[1].sub).toBe("main");
		expect((all[3].group as Exclude<GroupLabel, string>[])[0]).toMatchObject({ tag: "app", muted: true });
	});

	test("apps are hidden unless asked for, and counted", () => {
		const b = build(snap([job({ pid: 1 }), job({ pid: 2, kind: "app", where: "Code" })]), opts);
		expect(b.rows.map((r) => r.id)).toEqual(["1"]);
		expect(b.hiddenApps).toBe(1);
	});

	test("jobs started from another job nest under it, which opens", () => {
		const rows = build(snap([job({ pid: 1 }), job({ pid: 2, parentRow: 1 })]), opts).rows;
		expect(rows.map((r) => r.id)).toEqual(["1"]);
		expect(rows[0].open).toBe(true);
		expect(rows[0].children?.map((c) => c.id)).toEqual(["2"]);
	});

	test("members nest by parent pid", () => {
		const m = (pid: number, ppid: number) => ({ pid, ppid, depth: 0, displayArgv: [], argvCommand: `m${pid}`, cwd: "/w/a", listen: [], tty: "", stat: "S", etimeSec: 1, rssKb: 1, cpu: 0, pidCount: 1 });
		const rows = build(snap([job({ pid: 1, members: [m(10, 1), m(11, 10), m(12, 1)] })]), opts).rows;
		expect(rows[0].children?.map((c) => c.id)).toEqual(["10", "12"]);
		expect(rows[0].children?.[0].children?.map((c) => c.id)).toEqual(["11"]);
		expect(rows[0].open).toBeUndefined();
	});
});

describe("sorting and search", () => {
	test("by started: newest first ascending, oldest first descending", () => {
		const s = snap([job({ pid: 1, etimeSec: 50 }), job({ pid: 2, etimeSec: 10 })]);
		expect(build(s, opts).rows.map((r) => r.id)).toEqual(["2", "1"]);
		expect(build(s, { ...opts, desc: true }).rows.map((r) => r.id)).toEqual(["1", "2"]);
	});

	test("by memory, sections order by their largest command", () => {
		const s = snap([job({ pid: 1, where: "A", rssKb: 10 }), job({ pid: 2, where: "B", rssKb: 500 })]);
		expect(build(s, { ...opts, sort: "memory", desc: true }).rows.map((r) => r.id)).toEqual(["2", "1"]);
	});

	test("search finds pids, ports, member commands; a member hit opens its job", () => {
		const s = snap([
			job({ pid: 50493, listen: [{ pid: 50493, port: 3000, host: "localhost" }] }),
			job({ pid: 7, members: [{ pid: 70, ppid: 7, depth: 0, displayArgv: [], argvCommand: "vite --port 5173", cwd: "/w/a", listen: [], tty: "", stat: "S", etimeSec: 1, rssKb: 1, cpu: 0, pidCount: 1 }] }),
		]);
		expect(build(s, { ...opts, query: "504" }).rows.map((r) => r.id)).toEqual(["50493"]);
		expect(build(s, { ...opts, query: ":3000" }).rows.map((r) => r.id)).toEqual(["50493"]);
		const hit = build(s, { ...opts, query: "vite" }).rows;
		expect(hit.map((r) => r.id)).toEqual(["7"]);
		expect(hit[0].open).toBe(true);
	});

	test("launchers that exited and guessed commands say so", () => {
		const r = build(snap([job({ pid: 1, leaderGone: true, pidCount: 3, source: "history" })]), opts).rows[0];
		const name = r.cells.name as { text: string; sub: string };
		expect(name.text.startsWith("⤷ ")).toBe(true);
		expect(name.sub).toContain("3 left running");
		expect(name.sub).toContain("guessed from history");
	});
});

test("agent state: working, or idle for how long", () => {
	expect(agentState({ harness: "codex", status: "working" })).toBe("working");
	expect(agentState({ harness: "codex", status: "idle", lastActive: 1_700_000_000_000 }, 1_700_000_000_000 + 125_000)).toBe("idle 2m");
});

test("sortTree keeps parents above children", () => {
	const m = (pid: number, ppid: number, cpu: number) => ({ pid, ppid, depth: 0, displayArgv: [], argvCommand: "", cwd: "", listen: [], tty: "", stat: "", etimeSec: 0, rssKb: 0, cpu, pidCount: 1 });
	const out = sortTree([m(2, 1, 1), m(3, 2, 9), m(4, 1, 5)], (x) => x.cpu, (a, b) => (b as number) - (a as number));
	expect(out.map((x) => x.pid)).toEqual([4, 2, 3]);
});

test("stripAnsi removes colors and cursor codes", () => {
	expect(stripAnsi("\x1b[32mok\x1b[0m \x1b[2K\x1b]0;title\x07done")).toBe("ok done");
});

describe("agents", () => {
	test("recognized by program, by the script a runtime runs, or by package path", () => {
		expect(detectAgent(["claude", "--resume", "x"])?.id).toBe("claude");
		expect(detectAgent(["/opt/homebrew/bin/node", "--no-warnings", "/usr/local/bin/gemini"])?.id).toBe("gemini");
		expect(detectAgent(["node", "/x/node_modules/@openai/codex/bin/codex.js"])?.id).toBe("codex");
		expect(detectAgent(["python3", "-m", "aider"])?.id).toBe("aider"); // python -m aider
		expect(detectAgent(["/Users/me/.local/bin/aider"])?.id).toBe("aider");
		expect(detectAgent(["bun", "run", "dev"])).toBeUndefined();
		expect(detectAgent(["vim", "claude.md"])).toBeUndefined();
	});

	test("every agent has a color and its own binaries", () => {
		const bins = AGENTS.flatMap((a) => a.bins);
		expect(new Set(bins).size).toBe(bins.length);
		expect(AGENTS.length).toBeGreaterThanOrEqual(15);
		for (const a of AGENTS) expect(HUES).toContain(a.hue);
	});

	test("activity: problems first, then what the agent says, else its CPU", () => {
		expect(activity({ stat: "T", cpu: 0, pid: 1 }, true)).toBe("paused");
		expect(activity({ stat: "S", cpu: 0, pid: 1 }, false)).toBe("running");
		expect(activity({ stat: "S", cpu: 0, pid: 1, agent: { harness: "claude", status: "working" } }, true)).toBe("working");
		expect(activity({ stat: "S", cpu: 0, pid: 1, agent: { harness: "claude", status: "idle" } }, true, { waiting: () => true })).toBe("waiting");
		expect(activity({ stat: "S", cpu: 40, pid: 1 }, true)).toBe("working");
		expect(activity({ stat: "S", cpu: 0, pid: 1 }, true)).toBe("idle");
	});
});

describe("dots, filters, targets", () => {
	const web = (pid: number, port: number) => ({ pid, port, pending: false, web: true, url: `http://localhost:${port}/` });
	const member = (pid: number, ppid: number, port?: number) => ({ pid, ppid, depth: 0, displayArgv: [], argvCommand: `m${pid}`, cwd: "/w/a", listen: port ? [{ pid, port, host: "localhost" }] : [], tty: "", stat: "S", etimeSec: 1, rssKb: 1, cpu: 0, pidCount: 1 });

	test("service kinds: web is blue, other listeners violet, busy agents pulse, idle ones dim", () => {
		const s = snap([], { probes: [web(1, 3000)] });
		const dot = (r: ProcRow) => statusDot(s, r) as Exclude<Dot, string>;
		expect(dot(job({ pid: 1, listen: [{ pid: 1, port: 3000, host: "" }] }))).toMatchObject({ color: "blue", label: "Web server — http://localhost:3000/" });
		expect(dot(job({ pid: 2, listen: [{ pid: 2, port: 5432, host: "" }] }))).toMatchObject({ color: "violet" });
		expect(dot(job({ pid: 3, displayArgv: ["claude"], agent: { harness: "claude", status: "working" } }))).toMatchObject({ color: "green", pulse: true });
		expect(dot(job({ pid: 4, displayArgv: ["codex"], agent: { harness: "codex", status: "idle" } }))).toMatchObject({ color: "green", dim: true });
	});

	test("filters keep the jobs whose value is checked; counts ignore their own filter", () => {
		const s = snap([job({ pid: 1, displayArgv: ["claude"], agent: { harness: "claude", status: "working" } }), job({ pid: 2, displayArgv: ["gemini"] }), job({ pid: 3 })]);
		expect(build(s, { ...opts, filters: { agent: ["claude", "gemini"] } }).rows.map((r) => r.id)).toEqual(["1", "2"]);
		expect(build(s, { ...opts, filters: { agent: ["none"] } }).rows.map((r) => r.id)).toEqual(["3"]);
		expect(build(s, { ...opts, filters: { service: ["agent-busy"] } }).rows.map((r) => r.id)).toEqual(["1"]);
		const counts = facetCounts(s, { ...opts, filters: { agent: ["claude"] } });
		expect(counts.agent.get("gemini")).toBe(1); // still offered
		expect(counts.service.get("agent-idle")).toBeUndefined(); // gemini is filtered out by agent
	});

	test("a job with processes of its own: actions ask which one, and the drawer lists them", () => {
		const s = snap([job({ pid: 1, tty: "ttys001", listen: [{ pid: 11, port: 3000, host: "" }, { pid: 12, port: 5432, host: "" }], members: [member(11, 1, 3000), member(12, 1, 5432), member(13, 1)] })], { probes: [web(11, 3000)] });
		const r = build(s, opts).rows[0];
		expect(r.targets?.output?.map((t) => t.id)).toEqual(["1", "11", "12", "13"]);
		expect(r.targets?.open?.map((t) => t.id)).toEqual(["http://localhost:3000/"]);
		const started = r.details!.filter((d) => d.section === "Started processes");
		expect(started[0]).toMatchObject({ label: "Summary", value: "3 in all · 1 web · 1 listening" });
		expect(started.slice(1).map((d) => d.actionRow)).toEqual(["11", "12", "13"]); // web, then other ports, then the rest
		expect(started[1].actions?.map((a) => a.id)).toEqual(["output", "open"]);
	});

	test("kept instances get a bookmark; heavy CPU and memory are toned", () => {
		const s = snap([job({ pid: 1, keptIndex: 0, cpu: 150, rssKb: 2 * 1024 * 1024 })], { kept: [{ index: 0, name: "web", command: "x", cwd: "/w/a", env: {}, note: "", ports: [], line: "x" }] });
		const cells = build(s, opts).rows[0].cells as Record<string, Exclude<Cell, string | number | null>>;
		expect(cells.name.marks?.[0]).toMatchObject({ icon: "bookmark" });
		expect(cells.name.marks?.[0].tooltip).toContain("“web”");
		expect(cells.cpu.tone).toBe("danger");
		expect(cells.mem.tone).toBe("warning");
	});
});

test("projectPart: the folder after a collection of projects, else the last one", () => {
	expect(projectPart("~/dev/projects/toolbelt")).toBe("toolbelt");
	expect(projectPart("~/dev/projects/toolbelt/src/ui")).toBe("toolbelt");
	expect(projectPart("~/worktrees/toolbelt/t3-b52a5434")).toBe("toolbelt");
	expect(projectPart("~/orca/workspaces/celebrate/startup-error")).toBe("celebrate");
	expect(projectPart("~/notes/2026")).toBe("2026");
	expect(projectPart("~/dev")).toBe("dev");
	expect(projectPart("/tmp")).toBe("tmp");
});

test("tmux sessions share one application and directory groups, retaining session and agent titles", () => {
    const rows = build(snap([
        job({ pid: 10, where: "tmux work:1.0", agent: { harness: "claude", title: "Fix the build" } }),
        job({ pid: 11, where: "tmux other:2.0" }),
        job({ pid: 12, where: "tmux work:3.0", cwd: "/w/b" }),
    ]), opts).rows;
    expect(rows.map(r => labels(r.group))).toEqual([["TMUX", "/w/a"], ["TMUX", "/w/a"], ["TMUX", "/w/b"]]);
    expect(rows[0].cells.name).toMatchObject({ text: "Fix the build", sub: "work:1.0", tags: expect.arrayContaining([expect.objectContaining({ icon: "asset:processes@0.0.1/agent-claude" })]) });
});

test("one classification drives both state filtering and row dots", () => {
    const jobs = [
        job({ pid: 1, stat: "T" }), job({ pid: 2, stat: "Z" }), job({ pid: 3, stat: "D" }),
        job({ pid: 4, agent: { harness: "claude", status: "new" } }),
        job({ pid: 5, agent: { harness: "claude", status: "working" } }),
        job({ pid: 6 }),
    ];
    const s = snap(jobs);
    for (const j of jobs) {
        const state = facetsOf(s, j, {}).service as keyof typeof SERVICE;
        expect(statusDot(s, j)).toMatchObject(SERVICE[state].dot);
        expect(build(s, { ...opts, filters: { service: [state] } }).rows.map(r => r.id)).toContain(String(j.pid));
    }
    expect(jobs.map(j => facetsOf(s, j, {}).service)).toEqual(["paused", "zombie", "disk", "agent-new", "agent-busy", "plain"]);
});

test("waiting agents pulse fuchsia and agent badges keep distinct recognizable colors", () => {
    const r = job({ pid: 8, agent: { harness: "codex", status: "idle" } });
    expect(statusDot(snap([r]), r, { waiting: () => true })).toMatchObject({ color: "fuchsia", pulse: true });
    expect(AGENTS.find(a => a.id === "codex")?.hue).toBe("blue");
    expect(AGENTS.find(a => a.id === "claude")?.hue).toBe("amber");
});

test("CMUX workspace and surface names are visible and searchable independently of cwd", () => {
    const r = job({ pid: 9, cmux: { workspace: "Different workspace", surface: "Upgrade dependencies" } });
    const rows = build(snap([r]), { ...opts, query: "Different workspace" }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.name).toMatchObject({ sub: expect.stringContaining("Different workspace / Upgrade dependencies") });
});

const groupSummary = (row: Row, level: number) => (row.group as Exclude<GroupLabel, string>[])[level].summary;

test("memory sorting ranks apps and folders by the largest command, not the displayed total", () => {
    const commands = [
        job({pid:1,where:"Many",cwd:"/many",rssKb:300*1024}),
        job({pid:2,where:"Many",cwd:"/many",rssKb:250*1024}),
        job({pid:3,where:"Many",cwd:"/many",rssKb:350*1024}),
        job({pid:4,where:"Largest",cwd:"/largest",rssKb:500*1024}),
    ];
    const descending = build(snap(commands), {...opts,sort:"memory",desc:true}).rows;
    expect(descending.map(r=>r.id)).toEqual(["4","3","1","2"]);
    expect(groupSummary(descending[0],0)?.value).toBe("Σ 500 MB");
    expect(groupSummary(descending[1],0)?.value).toBe("Σ 900 MB");
    expect(build(snap(commands),{...opts,sort:"memory",desc:false}).rows.map(r=>r.id)).toEqual(["2","1","3","4"]);
    const sameApp = commands.map(r=>({...r,where:"Terminal"}));
    expect(build(snap(sameApp),{...opts,sort:"memory",desc:true}).rows.map(r=>r.id)).toEqual(["4","3","1","2"]);
    expect(build(snap(sameApp),{...opts,sort:"memory",desc:false}).rows.map(r=>r.id)).toEqual(["2","1","3","4"]);
});

test("group totals include nested jobs once without recounting ordinary process members", () => {
    const rows = [
        job({pid:1,rssKb:1024,members:[{pid:11,ppid:1,depth:0,displayArgv:[],argvCommand:"helper",cwd:"/w/a",listen:[],tty:"",stat:"S",etimeSec:1,rssKb:512,cpu:0,pidCount:1}]}),
        job({pid:2,parentRow:1,cwd:"/w/b",rssKb:2048,command:"uniquenestedcommand"}),
        job({pid:3,rssKb:4096}),
        job({pid:4,cwd:"/w/c",rssKb:8192}),
    ];
    const built = build(snap(rows),opts).rows;
    expect(groupSummary(built[0],0)?.value).toBe("Σ 15 MB");
    expect(groupSummary(built.find(r=>r.id==="1")!,1)?.value).toBe("Σ 7 MB");
    expect(groupSummary(built.find(r=>r.id==="4")!,1)?.value).toBe("Σ 8 MB");
    expect(built.find(r=>r.id==="1")!.children?.some(r=>r.id==="2")).toBe(true);
    const filtered = build(snap(rows),{...opts,query:"uniquenestedcommand"}).rows;
    expect(filtered.map(r=>r.id)).toEqual(["2"]);
    expect(groupSummary(filtered[0],0)?.value).toBe("Σ 2 MB");
    expect(groupSummary(filtered[0],1)?.value).toBe("Σ 2 MB");
});

test("a folder ranks by its largest nested job and CPU grouping still uses sums", () => {
    const rows = [job({pid:1,rssKb:1024,cpu:3}),job({pid:2,parentRow:1,cwd:"/different",rssKb:10240,cpu:0}),job({pid:3,cwd:"/z",rssKb:5120,cpu:1})];
    const memory = build(snap(rows),{...opts,sort:"memory",desc:true}).rows;
    expect(memory.map(r=>r.id)).toEqual(["1","3"]);
    expect(groupSummary(memory[0],1)?.value).toBe("Σ 11 MB");
    const apps = [job({pid:1,where:"Many",cpu:3}),job({pid:2,where:"Many",cpu:3}),job({pid:3,where:"Single",cpu:5})];
    expect(build(snap(apps),{...opts,sort:"cpu",desc:true}).rows.map(r=>r.id)).toEqual(["1","2","3"]);
});
