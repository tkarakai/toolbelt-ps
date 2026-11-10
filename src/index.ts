import { asset } from "@toolbelt/sdk";
// Processes: a Toolbelt plugin that drives running-core (src/serve.ts in
// github.com/tkarakai/running) and draws its processes, kept commands and settings. It has
// everything running's TUI has: sections by terminal, folders and branches, agents, ports,
// output (and agents' conversations), keep / edit / forget / reorder, restart, stop and force
// stop, "why is it still alive", copy the command line, shell integration status.
// The engine and TUI are owned by this repository.
//
// running is maintained in ./running and packaged in payload/ (paths.ts); tui.ts puts its
// terminal UI on the PATH.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, definePlugin, type Action, type Context, type Dialog, type Dot, type Field, type Message, type Node, type Row } from "@toolbelt/sdk";
import { readConversation } from "./conversation";
import { Core, type Hello, type KeepDraft, type Peek, type Snapshot, type SortKey } from "./core";
import { coreScript } from "./paths";
import { readCmuxLocations } from "./cmux";
import { Tui } from "./tui";
import { claudeWaiting, AGENTS } from "./agents";
import { agentOf, agentState, build, COLUMN_SORT, displayName, dur, facetCounts, FILTERS, locate, projectPart, SERVICE, SORT_COLUMN, sourceLabel, statusDot, stripAnsi, tildify, webUrl, type Built, type FilterId, type Options, type Service } from "./model";

const core = new Core(coreScript(), {
	onChanged: () => void refresh(),
	onExit: () => ctx.invalidate(),
});

const tui = new Tui({ onChange: () => ctx.invalidate() });

// ── state ────────────────────────────────────────────────────────────────
let snap: Snapshot | null = null;
let hello: Hello | null = null;
const installedTerminals = new Set(["terminal"]);
function availableTerminals(): Hello["terminals"] {
    return Object.fromEntries(Object.entries(hello?.terminals ?? { terminal: { label: "Terminal" } }).filter(([id]) => installedTerminals.has(id)));
}
function discoverTerminals() {
    for (const [id, t] of Object.entries(hello?.terminals ?? {})) {
        if (id === "tmux" ? !!Bun.which("tmux") : t.app && ["/Applications", "/System/Applications/Utilities", join(process.env.HOME ?? "", "Applications")].some(root => existsSync(join(root, t.app + ".app")))) installedTerminals.add(id);
    }
    if (!availableTerminals()[terminal]) terminal = prefs.terminal = "terminal";
}
let query = "";
// The person's choices, kept in the plugin's data folder across restarts.
const PREFS = join(dataDir(), "prefs.json");
const prefs: { showAll: boolean; terminal: string; filters: Partial<Record<FilterId, string[]>> } = { showAll: false, terminal: "terminal", filters: {} };
try {
	if (existsSync(PREFS)) Object.assign(prefs, JSON.parse(readFileSync(PREFS, "utf8")));
} catch {}
// Retain only the supported filters when upgrading from separate Status / Kind controls.
prefs.filters = { agent: prefs.filters.agent, service: prefs.filters.service?.flatMap(v => v === "problem" ? ["paused", "zombie", "disk"] : v in SERVICE ? [v] : []) };
const savePrefs = () => {
	try {
		writeFileSync(PREFS, JSON.stringify(prefs, null, "\t") + "\n");
	} catch {}
};
let showAll = prefs.showAll;
let terminal = prefs.terminal;
let refreshing = false;
let last: Built | null = null;
/** Recent CPU / memory per pid, for the sparklines. */
const history = new Map<number, { cpu: number[]; mem: number[] }>();
const HISTORY = 30;

/** The dialog over the Processes or Kept page. */
type Open =
	| { kind: "output"; pid: number; child?: number; source?: string; data?: Peek; messages?: Message[]; error?: string }
	/** Keep a process (`pid`), edit a kept command (`index`), or add one by hand (neither). */
	| { kind: "keep"; pid?: number; index?: number; draft: KeepDraft; saving?: boolean };
let dialog: Open | null = null;
let dialogScreen: "processes" | "kept" = "processes";

async function refresh() {
	if (refreshing || !core.running) return;
	refreshing = true;
	try {
		snap = await core.call<Snapshot>("snapshot");
        const cmux = readCmuxLocations();
        for (const row of snap.rows) row.cmux = cmux.get(row.term?.cmuxsurface?.toLowerCase() ?? "");
		recordHistory(snap);
		ctx.badge(snap.rows.filter((r) => showAll || r.kind !== "app").length || null);
		if (dialog?.kind === "output") await loadOutput();
		ctx.invalidate();
	} catch (e) {
		if (!core.error) ctx.toast((e as Error).message, "error");
		ctx.invalidate();
	} finally {
		refreshing = false;
	}
}

function recordHistory(s: Snapshot) {
	const alive = new Set<number>();
	const push = (pid: number, cpu: number, rssKb: number) => {
		alive.add(pid);
		const h = history.get(pid) ?? { cpu: [], mem: [] };
		h.cpu.push(cpu);
		h.mem.push(rssKb);
		if (h.cpu.length > HISTORY) (h.cpu.shift(), h.mem.shift());
		history.set(pid, h);
	};
	for (const r of s.rows) {
		push(r.pid, r.cpu, r.rssKb);
		for (const m of r.members) push(m.pid, m.cpu, m.rssKb);
	}
	for (const pid of history.keys()) if (!alive.has(pid)) history.delete(pid);
}

/** How much of a terminal's scrollback (or a log file) a peek shows. */
const PEEK_LINES = 1000;

async function loadOutput() {
	if (dialog?.kind !== "output") return;
	const d = dialog;
	try {
		const conversation = d.source === "@transcript";
		d.data = await core.call<Peek>("peek", { pid: d.pid, ...(d.child ? { child: d.child } : {}), ...(d.source ? { source: d.source } : {}), lines: conversation ? 1 : PEEK_LINES });
		const agent = locate(snap, d.pid)?.row.agent;
		d.messages = conversation && agent?.transcript ? readConversation(agent.transcript, agent.harness) : undefined;
		d.error = undefined;
	} catch (e) {
		d.error = (e as Error).message;
	}
}

// ── views ────────────────────────────────────────────────────────────────
const unavailable = (): Node => ({
	type: "empty",
	icon: "plug-zap",
	title: "running-core isn't available",
	description: `${core.error}. Rebuild the plugins (bun run plugins), or set RUNNING_CORE_SCRIPT to a running checkout's src/serve.ts.`,
});

/** A kept command typed in by hand (running-core keeps processes; restoring an entry at the
 *  end of the list is how a new one gets in). */
async function addKept(v: { name: string; command: string; cwd: string; note: string; env: KeepDraft["env"] }): Promise<{ ok: boolean; message: string }> {
	const command = v.command.trim(), cwd = v.cwd.trim() || "~";
	if (!command) return { ok: false, message: "The command can't be empty" };
	const name = v.name.trim() || command.split(/\s+/)[0].split("/").pop()!;
	if (snap?.kept.some((k) => k.command === command && tildify(k.cwd) === tildify(cwd))) return { ok: false, message: `Already kept` };
	const entry = { name, command, cwd: tildify(cwd), env: Object.fromEntries(v.env.filter(e => e.selected && e.key).map(e => [e.key, e.value])), note: v.note.trim(), ports: [], kept: new Date().toISOString() };
	await core.call("restoreKept", { kept: entry, index: snap?.kept.length ?? 0 });
	return { ok: true, message: `Kept “${name}”` };
}

/** Claude Code says when it waits for the person; read once per render (it's a small file). */
function waitingCheck(): Options["waiting"] {
	const claude = new Set(snap?.rows.filter((r) => r.agent?.harness === "claude").map((r) => r.pid));
	const seen = new Map<number, boolean>();
	return (pid) => {
		if (!claude.has(pid)) return false;
		if (!seen.has(pid)) seen.set(pid, claudeWaiting(pid));
		return seen.get(pid)!;
	};
}

/** Every filter option stays visible, including zero counts. */
function filtersFor(o: Options) {
	if (!snap) return [];
	const counts = facetCounts(snap, o);
	const option = (id: FilterId, value: string, label: string, dot?: Dot) => ({ value, label, count: counts[id].get(value) ?? 0, ...(dot ? { dot } : {}) });
	const options: Record<FilterId, ReturnType<typeof option>[]> = {
		agent: [...AGENTS.map((a) => option("agent", a.id, a.name, a.hue)), option("agent", "none", "Not an agent")],
		service: (Object.keys(SERVICE) as Service[]).map((k) => option("service", k, SERVICE[k].label, SERVICE[k].dot)),
	};
	return FILTERS.map((f) => ({ ...f, options: options[f.id], selected: prefs.filters[f.id] ?? [] }));
}

const sortKey = (): SortKey => snap?.sort.key ?? "started";
const sortDesc = () => snap?.sort.desc ?? true;

/** The sources a peek can show, and which one is showing (running falls back to the first log
 *  file when a job has no terminal to read). */
function outputSources(d: Extract<Open, { kind: "output" }>) {
	const files = d.data?.sources ?? [];
	const fellBack = d.source === undefined && !!d.data && files.includes(d.data.title);
	const list: (string | undefined)[] = [...(fellBack ? [] : [undefined]), ...files].filter((s, i, a) => a.indexOf(s) === i);
	return { list, showing: fellBack ? d.data!.title : d.source };
}

const sourceIcon = (s: string | undefined) => (s === undefined ? "square-terminal" : s === "@transcript" ? "messages-square" : "file-text");

function outputDialog(d: Extract<Open, { kind: "output" }>): Dialog {
	const { list, showing } = outputSources(d);
	const key = (s: string | undefined) => s ?? "@terminal";
	const row = locate(snap, d.pid);
	const name = row ? (row.member ? row.member.argvCommand : displayName(row.row)) : String(d.pid);
	const conversation = showing === "@transcript";
	const id = `out:${d.pid}:${d.child ?? ""}:${showing ?? ""}`;
	return {
		id: "output",
		title: `Peek — ${name}`,
		description: d.error ?? (conversation ? `${row?.row.agent?.harness ?? "Agent"} conversation · ${d.messages?.length ?? 0} messages · live` : `${d.data?.title ?? "…"} · ${d.data?.lines.length ?? 0} lines · live`),
		wide: true,
		resizable: true,
		children: [
			...(list.length > 1 ? [{ type: "segmented" as const, id: "output-source", value: key(showing), options: list.map((s) => ({ value: key(s), label: sourceLabel(s), icon: sourceIcon(s) })) }] : []),
			conversation
				? { type: "conversation" as const, id, messages: d.messages ?? [], empty: d.data ? "No messages yet." : "Loading…" }
				: { type: "terminal" as const, id, lines: d.data?.lines ?? [], follow: true, empty: d.data ? "No output." : "Loading…" },
		],
		actions: [{ id: "output-copy", label: "Copy all", icon: "copy" }],
	};
}

function keepDialog(d: Extract<Open, { kind: "keep" }>): Dialog {
	const editing = d.index !== undefined;
	const fields: Field[] = [
		{ type: "text", id: "name", label: "Name", value: d.draft.name, placeholder: "web dev server" },
		{ type: "text", id: "command", label: "Command", value: d.draft.command, placeholder: "bun run dev" },
		{ type: "text", id: "cwd", label: "Directory", value: d.draft.cwd },
		{ type: "text", id: "note", label: "Note", value: d.draft.note, placeholder: "optional" },
		{ type: "environment", id: "environment", label: "Environment", value: d.draft.env, description: "Included variables are saved with this command. Secret values stay masked." },
	];
	return {
		id: "keep",
        wide: true,
		title: editing ? `Edit “${d.draft.name}”` : d.draft.title,
		description:
			d.draft.alreadyKept && !editing ? `Already kept as “${d.draft.alreadyKept.name}” — saving updates it.`
			: !editing && d.pid === undefined ? "A command to start again whenever you like: it runs in this folder, in a new terminal window."
			: d.draft.env.length ? "Environment variables that differ from your shell can be kept with it." : undefined,
		children: [{ type: "form", id: "keep", fields }],
		actions: [{ id: "keep-save", label: editing || d.draft.alreadyKept ? "Save" : "Keep", icon: "bookmark", primary: true, disabled: d.saving || !d.draft.command.trim() }],
	};
}

const currentDialog = (screen: "processes" | "kept"): Dialog | undefined => {
	if (!dialog || dialogScreen !== screen) return undefined;
	return dialog.kind === "output" ? outputDialog(dialog) : keepDialog(dialog);
};

function processesScreen(): Node {
	if (core.error) return unavailable();
	const o: Options = { query, showAll, sort: sortKey(), desc: sortDesc(), history, filters: prefs.filters, waiting: waitingCheck() };
	last = snap ? build(snap, o) : null;
	const filtering = FILTERS.some((f) => prefs.filters[f.id]?.length);
	return {
		type: "page",
		search: { placeholder: "Filter by command, folder, port, pid, agent…" },
		filters: filtersFor(o),
		summary: last ? `${last.shown} of ${last.total - last.hiddenApps} processes${last.hiddenApps ? ` · ${last.hiddenApps} apps hidden` : ""}` : "Loading…",
		highlight: last?.search.highlight(),
		actions: [
			{ id: "toggle-apps", label: "Show apps", checked: showAll },
		],
		dialog: currentDialog("processes"),
		children: [
			{
				type: "table",
				id: "processes",
				// Narrow windows hide columns from the right; the process name always stays.
				columns: [
					{ key: "name", title: "Process", grow: true, minWidth: 260, sortable: true },
					{ key: "ports", title: "Ports" },
					{ key: "cpu", title: "CPU", align: "right", mono: true, sortable: true, sortDesc: true },
					{ key: "mem", title: "Memory", align: "right", mono: true, sortable: true, sortDesc: true },
					{ key: "uptime", title: "Up", align: "right", mono: true, sortable: true },
				],
				sort: { key: SORT_COLUMN[sortKey()], desc: sortDesc() },
				rows: last?.rows ?? [],
				actions: PROCESS_ACTIONS,
				empty: {
					title: !snap ? "Loading…" : query || filtering ? "No process matches" : "Nothing running",
					description: filtering ? "Nothing passes the filters — uncheck some, or pick “Show all” in a filter's menu." : snap && !query ? (last?.hiddenApps ? "Apps and system servers are hidden — Show apps lists them." : "Processes you start in your terminals show up here.") : undefined,
					icon: "terminal",
				},
			},
		],
	};
}

/**
 * Row actions, in groups: get to it (its terminal, its output, its page) · understand it · keep
 * or reuse its command · restart it · stop it.
 */
const PROCESS_ACTIONS: Action[] = [
	{ id: "focus", label: "Jump to terminal", icon: "square-arrow-out-up-right", inline: true, group: "go", key: "j" },
	{ id: "output", label: "Peek", icon: "scan-eye", inline: true, group: "go", key: "p" },
	{ id: "open", label: "Open in browser", icon: "globe", inline: true, group: "go", key: "b" },
	{ id: "why", label: "Why is it still running?", icon: "circle-help", group: "go", key: "w" },
	{ id: "keep", label: "Keep…", icon: "bookmark-plus", group: "command", key: "k" },
	{ id: "edit-kept", label: "Edit kept command…", icon: "bookmark", group: "command", key: "k" },
	{ id: "copy", label: "Copy cd && command", icon: "copy", group: "command", key: "c" },
	{ id: "restart", label: "Restart", icon: "rotate-cw", group: "run", key: "r", confirm: "Stop it and run the same command again — in its terminal if that's still open, otherwise in a new window." },
	{ id: "stop", label: "Stop", icon: "square", tone: "destructive", group: "stop", confirm: "Stop it (SIGTERM, then SIGCONT so paused jobs can exit)?" },
	{ id: "kill", label: "Force stop", icon: "octagon-x", tone: "destructive", group: "stop", confirm: "Force stop it now (SIGKILL)? It gets no chance to clean up." },
];

function keptScreen(): Node {
	if (core.error) return unavailable();
	const kept = snap?.kept ?? [];
	return {
		type: "page",
		summary: `${kept.length} kept · ${kept.filter((k) => k.livePid).length} running`,
		actions: [{ id: "add-kept", label: "Add…", icon: "plus" }],
		dialog: currentDialog("kept"),
		children: [
			{
				type: "table",
				id: "kept",
				columns: [
					{ key: "name", title: "Name", grow: true },
					{ key: "dir", title: "Directory", optional: true },
					{ key: "state", title: "State" },
				],
				rows: kept.map(
					(k, i): Row => ({
						id: String(k.index),
                        targets: { "start-in": Object.entries(availableTerminals()).filter(([id]) => id !== terminal).map(([id, t]) => ({ id, label: t.label, icon: "square-terminal" })) },
						cells: {
							name: { text: k.name || k.command, sub: k.line, mono: false },
							dir: { text: tildify(k.cwd), strong: projectPart(tildify(k.cwd)), mono: true, tone: "muted" },
							state: k.livePid ? { text: "Running", dot: { color: "green", label: `Running — pid ${k.livePid}` }, sub: `pid ${k.livePid}` } : { text: "Stopped", dot: { color: "muted", label: "Not running — S starts it" }, tone: "muted" },
						},
						actions: ["start", ...(k.livePid ? ["focus-kept"] : []), ...(Object.keys(availableTerminals()).length > 1 ? ["start-in"] : []), "edit", "copy", "reveal-kept", ...(i > 0 ? ["up"] : []), ...(i < kept.length - 1 ? ["down"] : []), "forget"],
						details: [
							{ section: "Command", label: "Command", value: k.line, mono: true },
							{ section: "Command", label: "Directory", value: tildify(k.cwd), mono: true },
							...(k.note ? [{ section: "Command", label: "Note", value: k.note }] : []),
							...Object.entries(k.env).map(([key, v]) => {
								const secret = /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH/i.test(key);
								return { section: "Environment", label: key, value: secret ? "••••••" : v, mono: true, copy: !secret };
							}),
							...(k.livePid ? [{ section: "State", label: "Running", value: `pid ${k.livePid}`, mono: true, copy: false, tone: "success" as const }] : [{ section: "State", label: "State", value: "Stopped" }]),
							...(k.ports.length ? [{ section: "State", label: "Ports", value: k.ports.map((p) => `:${p}`).join(" ") }] : []),
							...(k.session ? [{ section: "State", label: "Agent session", value: k.session, mono: true }] : []),
							...(k.kept ? [{ section: "State", label: "Kept on", value: new Date(k.kept).toLocaleString() }] : []),
						],
					}),
				),
				actions: [
					{ id: "start", label: `Start in ${hello?.terminals[terminal]?.label ?? terminal}`, icon: "play", inline: true, group: "run", key: "s" },
					{ id: "start-in", label: "Start in…", icon: "square-terminal", group: "run" },
                    { id: "reveal-kept", label: "Reveal directory in Finder", icon: "folder-open", group: "command" },
                    { id: "focus-kept", label: "Jump to terminal", icon: "square-arrow-out-up-right", inline: true, group: "run", key: "j" },
					{ id: "edit", label: "Edit…", icon: "pencil", inline: true, group: "command", key: "e" },
					{ id: "copy", label: "Copy cd && command", icon: "copy", group: "command", key: "c" },
					{ id: "up", label: "Move up", icon: "arrow-up", group: "order", key: "[" },
					{ id: "down", label: "Move down", icon: "arrow-down", group: "order", key: "]" },
					{ id: "forget", label: "Forget", icon: "trash-2", tone: "destructive", group: "forget", key: "x", confirm: "Forget this kept command? (You can undo right after.)" },
				],
					empty: { title: "Nothing kept yet", description: "Keep a process (select it, then K) to start it again later, with its folder and environment — or add a command with Add….", icon: "bookmark" },
			},
		],
	};
}

function settingsScreen(): Node {
	tui.checkOnce();
	return {
		type: "page",
		children: [
			{
				type: "form",
				id: "settings",
				title: "Default terminal",
                description: "Kept commands open in a new window of this terminal. Choose another terminal for an individual command with Start in….",
				fields: [
					{ type: "select", id: "terminal", label: "Open commands in", value: terminal, options: Object.entries(availableTerminals()).map(([value, t]) => ({ value, label: t.label })), description: "Only installed, supported terminals are listed." },
				],
			},
			tui.card(hello ? { logFile: hello.logFile, ...hello.shell } : null, hello?.version),
			{
				type: "card",
				id: "core",
				title: "running-core",
				children: [
					{
						type: "details",
						items: [
							{ label: "Version", value: hello?.version ?? "?" },
							{ label: "Engine", value: tildify(core.script), mono: true },
							{ label: "Kept list", value: hello ? tildify(hello.keptFile) : "?", mono: true },
							{ label: "Command log", value: hello ? tildify(hello.logFile) : "?", mono: true },
						],
					},
				],
			},
		],
	};
}

function quickView(): Node {
	if (core.error) return unavailable();
	const rows = (snap?.rows ?? []).filter((r) => r.kind !== "app").sort((a, b) => b.listen.length - a.listen.length || a.etimeSec - b.etimeSec);
	return {
		type: "list",
		id: "quick",
		items: rows.slice(0, 8).map((r) => ({
			id: String(r.pid),
			title: displayName(r),
            icon: agentOf(r) ? asset(`agent-${agentOf(r)!.id}`) : undefined,
			subtitle: [r.agent ? `${r.agent.harness} · ${agentState(r.agent)}` : r.listen.map((l) => `:${l.port}`).join(" "), tildify(r.cwd)].filter(Boolean).join("  "),
			dot: snap ? statusDot(snap, r, { waiting: waitingCheck() }) : "muted",
			meta: dur(r.etimeSec),
			actions: [{ id: "focus", label: "Jump to terminal", icon: "square-arrow-out-up-right" }, ...(snap && webUrl(snap, r) ? [{ id: "open", label: "Open in browser", icon: "globe" }] : [])],
		})),
		empty: { title: "Nothing running", icon: "terminal" },
	};
}

// ── plugin ───────────────────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;
function schedule(c: Context) {
	if (timer) clearInterval(timer);
	// Every 2 s while something is on screen (sparklines, live output), every 15 s for the badge.
	timer = setInterval(() => void refresh(), c.open.size ? 2000 : 15000);
}

/** After a stop: if it's still there a moment later, say why (zombie, stuck on disk, respawned). */
function checkSurvivor(pid: number, child: number | undefined, name: string, c: Context) {
	setTimeout(async () => {
		await refresh();
		if (!locate(snap, child ?? pid)) return;
		try {
			const res = await core.call<{ alive: boolean; reason?: string }>("whyAlive", { pid, ...(child ? { child } : {}) });
			if (res.alive) c.toast(`${name} is still running${res.reason ? `: ${res.reason}` : ""}`, "error");
		} catch {}
	}, 2500);
}

const ctx = definePlugin({
	prepare: async () => ({ready:true}),
	stop: async () => { if(timer) clearInterval(timer); core.stop(); },
	async start(c) {
		core.start();
		if (core.running) hello = await core.call<Hello>("hello").catch(() => null);
		discoverTerminals();
		await refresh();
		schedule(c);
	},
	onOpen: (_s, c) => {
		schedule(c);
		void refresh();
	},
	onClose: (s, c) => {
		if ((s === "screen:processes" || s === "screen:kept") && dialog) dialog = null;
		schedule(c);
	},
	render: {
		"screen:processes": processesScreen,
		"screen:kept": keptScreen,
		"screen:settings": settingsScreen,
		quick: quickView,
	},
	async onEvent(surface, event, payload, c) {
		const screen = surface === "screen:kept" ? "kept" : "processes";
		// A row action can name which of the row's processes it's for (`target`: a pid, or a URL).
		const target = payload?.target !== undefined ? String(payload.target) : undefined;
		const targetUrl = target?.includes("://") ? target : undefined;
		const pid = Number(target && !targetUrl ? target : payload?.rowId);
		const found = locate(snap, pid);
		const row = found?.row;
		const child = found?.member?.pid;
		const label = found?.member ? found.member.argvCommand : row ? displayName(row) : String(pid);
		const keptAt = (id: unknown) => snap?.kept.find((k) => k.index === Number(id));
		try {
			// ── dialogs ──
			if (event === "dialog-close") {
				dialog = null;
				return c.invalidate();
			}
			if (event === "field" && payload?.form === "output-source" && dialog?.kind === "output") {
				dialog.source = payload.value === "@terminal" ? undefined : String(payload.value);
				dialog.data = undefined;
				c.invalidate();
				await loadOutput();
				return c.invalidate();
			}
			if (event === "output-copy" && dialog?.kind === "output") {
				const d = dialog;
				c.copy(d.source === "@transcript" ? (d.messages ?? []).map((m) => (m.role === "tool" ? `[${m.tool?.name}] ${m.text}` : `${m.author}:\n${m.text}`)).join("\n\n") : (d.data?.lines ?? []).map(stripAnsi).join("\n"));
				return c.toast("Output copied", "success");
			}
			if (event === "field" && payload?.form === "keep" && dialog?.kind === "keep") {
				const f = String(payload.field);
				if (f === "environment" && Array.isArray(payload.value)) {
                    dialog.draft.env = payload.value.map((e: any) => ({ key: String(e.key ?? ""), value: String(e.value ?? ""), selected: !!e.selected, secret: !!e.secret }));
                } else if (f === "name" || f === "command" || f === "cwd" || f === "note") dialog.draft[f] = String(payload.value);
				return c.invalidate();
			}
			if (event === "keep-save" && dialog?.kind === "keep") {
				const d = dialog;
				const included = d.draft.env.filter(e => e.selected);
                if (included.some(e => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key))) return c.toast("Each included variable needs a valid name", "error");
                if (new Set(included.map(e => e.key)).size !== included.length) return c.toast("Variable names must be unique", "error");
                const values = { name: d.draft.name, command: d.draft.command, cwd: d.draft.cwd, note: d.draft.note, env: d.draft.env };
				const index = d.index ?? d.draft.alreadyKept?.index;
				d.saving = true;
				c.invalidate();
				const res =
					index !== undefined ? await core.call<{ ok: boolean; message: string }>("edit", { index, values })
					: d.pid !== undefined ? await core.call<{ ok: boolean; message: string }>("keep", { pid: d.pid, values })
					: await addKept(values);
				d.saving = false;
				c.toast(res.message, res.ok ? "success" : "error");
				if (res.ok) dialog = null;
				return void (await refresh());
			}
			if (surface === "toast" && event === "undo-forget") {
				const res = await core.call<{ ok: boolean; message: string }>("restoreKept", { kept: payload?.kept, index: payload?.index });
				c.toast(res.message, res.ok ? "success" : "error");
				return void (await refresh());
			}

			if (event === "start-in") {
                const target = String(payload?.target);
                if (!availableTerminals()[target]) return;
                const res = await core.call("start", { index: Number(payload?.rowId), terminal: target });
                c.toast(res.message, res.ok === false ? "error" : "success");
                return void (await refresh());
            }
            if (event === "reveal-kept") {
                const k = keptAt(payload?.rowId);
                if (k) { const path = k.cwd.replace(/^~(?=\/|$)/, process.env.HOME ?? ""); const p = Bun.spawn(["open", path], { stdout: "ignore", stderr: "ignore" }); await p.exited; }
                return;
            }
            switch (event) {
				case "search":
					query = String(payload?.query ?? "");
					return c.invalidate();
				case "refresh":
					break;
				case "filter": {
					const id = String(payload?.filter) as FilterId;
					if (!FILTERS.some((f) => f.id === id)) break;
					prefs.filters = { ...prefs.filters, [id]: Array.isArray(payload?.values) ? payload.values.map(String) : [] };
					savePrefs();
					return c.invalidate();
				}
				case "add-kept":
					dialog = { kind: "keep", draft: { title: "Add a kept command", name: "", command: "", cwd: "~", note: "", env: [] } };
					dialogScreen = "kept";
					return c.invalidate();
				case "toggle-apps":
					showAll = prefs.showAll = !showAll;
					savePrefs();
					break;
				case "sort": {
					const key = COLUMN_SORT[String(payload?.key)];
					if (key) await core.call("setSort", { key, desc: !!payload?.desc });
					break;
				}
				case "focus":
					if (row) await core.call("focus", { pid: row.pid });
					break;
				case "open": {
					const url = targetUrl ?? (found && snap && webUrl(snap, found.member ?? found.row));
					if (url) await core.call("openUrl", { url });
					break;
				}
				case "output":
					if (!row) break;
					dialog = { kind: "output", pid: row.pid, child, source: !child && row.agent?.transcript ? "@transcript" : undefined };
					dialogScreen = "processes";
					c.invalidate();
					await loadOutput();
					return c.invalidate();
				case "copy": {
					const k = screen === "kept" ? keptAt(payload?.rowId) : undefined;
					const cwd = k ? k.cwd : (found?.member?.cwd ?? row?.cwd ?? "");
					const command = k ? k.line : (found?.member?.argvCommand ?? row?.command ?? "");
					const res = await core.call<{ line: string }>("copyLine", { cwd, command });
					c.copy(res.line);
					return c.toast("Copied — paste it in a terminal", "success");
				}
				case "keep": {
					if (!row) break;
					const draft = await core.call<KeepDraft>("keepDraft", { pid: row.pid });
					dialog = { kind: "keep", pid: row.pid, draft };
					dialogScreen = "processes";
					return c.invalidate();
				}
				case "edit-kept":
				case "edit": {
					const k = event === "edit" ? keptAt(payload?.rowId) : row?.keptIndex !== undefined ? keptAt(row.keptIndex) : undefined;
					if (!k) break;
					dialog = {
						kind: "keep",
						index: k.index,
						draft: { title: "Edit kept command", name: k.name ?? "", command: k.command, cwd: k.cwd, note: k.note, env: Object.entries(k.env).map(([key, value]) => ({ key, value, secret: /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH/i.test(key), selected: true })) },
					};
					dialogScreen = event === "edit" ? "kept" : "processes";
					return c.invalidate();
				}
				case "restart": {
					if (!row) break;
					const res = await core.call<{ ok: boolean; message?: string }>("restart", { pid: row.pid, terminal });
					c.toast(res.message ?? (res.ok ? "Restarted" : "Couldn't restart"), res.ok ? "success" : "error");
					break;
				}
				case "stop":
				case "kill":
					if (!row) break;
					await core.call("kill", { pid: row.pid, ...(child ? { child } : {}), ...(event === "kill" ? { force: true } : {}) });
					c.toast(`${event === "kill" ? "Force-stopped" : "Stopped"} ${label}`, "success");
					checkSurvivor(row.pid, child, label, c);
					break;
				case "why": {
					if (!row) break;
					const res = await core.call<{ alive: boolean; reason?: string }>("whyAlive", { pid: row.pid, ...(child ? { child } : {}) });
					c.toast(res.alive ? `${label}: ${res.reason ?? "still running"}` : `${label} has exited`, res.alive ? "default" : "success");
					break;
				}
				case "start": {
					const res = await core.call<{ ok?: boolean; message?: string }>("start", { index: Number(payload?.rowId), terminal });
					c.toast(res?.message ?? "Started", res?.ok === false ? "error" : "success");
					break;
				}
				case "focus-kept": {
					const live = keptAt(payload?.rowId)?.livePid;
					if (live) await core.call("focus", { pid: live });
					break;
				}
				case "up":
				case "down": {
					const from = Number(payload?.rowId);
					await core.call("move", { from, to: from + (event === "up" ? -1 : 1) });
					break;
				}
				case "forget": {
					const index = Number(payload?.rowId);
					const res = await core.call<{ ok: boolean; message: string; restore: unknown }>("forget", { index });
					c.toast(res.message, "success", { id: "undo-forget", label: "Undo", payload: { kept: res.restore, index } });
					break;
				}
				case "tui-install":
				case "tui-remove":
				case "tui-check":
					await tui.onEvent(event, c, async () => void (hello = (await core.call<Hello>("hello").catch(() => null)) ?? hello));
					return c.invalidate();
				case "copy-init":
					c.copy(`eval "$(command running init)"`);
					return c.toast("Copied — add it to ~/.zshrc, then open a new terminal", "success");
				case "field":
					if (payload?.field === "terminal" && availableTerminals()[String(payload.value)]) terminal = prefs.terminal = String(payload.value);
					savePrefs();
					break;
			}
		} catch (e) {
			c.toast((e as Error).message, "error");
		}
		await refresh();
	},
});
