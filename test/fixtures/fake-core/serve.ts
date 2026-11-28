// A stand-in for running-core in plugin tests: answers the JSON-lines requests the plugin makes
// with a fixed snapshot (a dev server, a Claude Code agent and an app service, and one kept
// command) and keeps the sort it's given. Actions answer as running-core would, but it never looks
// at, starts or stops a real process.
const job = (p: Record<string, unknown>) => ({
	kind: "term", displayArgv: [], source: "typed", leaderGone: false, listen: [], where: "Terminal", tty: "ttys001", stat: "S",
	etimeSec: 60, rssKb: 2048, cpu: 1, pidCount: 1, members: [], termLabel: "", shellAlive: true, ...p,
});
const rows = [
	job({ pid: 101, command: "bun run dev", argvCommand: "bun run dev", cwd: "/w/web", listen: [{ pid: 101, port: 5173, host: "127.0.0.1" }] }),
	job({ pid: 102, command: "claude", argvCommand: "claude", cwd: "/w/api", agent: { harness: "claude", status: "working" } }),
	job({ pid: 103, kind: "app", command: "Helper", argvCommand: "Helper", cwd: "/", where: "Code", tty: "", listen: [{ pid: 103, port: 5000, host: "127.0.0.1" }] }),
];
const keptEntry = { index: 0, name: "web", command: "bun run dev", line: "bun run dev", cwd: "/w/web", env: {}, note: "", ports: [], kept: "2026-11-01T00:00:00.000Z" };
let kept = [keptEntry];
let sort = { key: "started", desc: true };
const terminals = { terminal: { label: "Terminal", app: "Terminal" } };
const answer = (method: string, params: any): unknown => {
	switch (method) {
		case "hello":
			return { version: "test", keptFile: "/tmp/kept.yaml", logFile: "/tmp/commands.log", shell: { zshrc: false, logExists: false }, terminals, sorts: {} };
		case "snapshot":
			return { at: 0, rows, kept, probes: [], branches: {}, sort };
		case "setSort":
			sort = { key: String(params.key), desc: !!params.desc };
			return { ok: true };
		case "forget":
			kept = [];
			return { ok: true, message: "Forgot “web”", restore: keptEntry };
		case "restoreKept":
			kept = [keptEntry];
			return { ok: true, message: "Restored “web”" };
		case "keepDraft":
			return { title: "Keep", name: "dev", command: "bun run dev", cwd: "/w/web", note: "", env: [] };
		case "keep":
		case "edit":
			return { ok: true, message: "Kept" };
		case "copyLine":
			return { line: `cd ${params.cwd} && ${params.command}` };
		case "whyAlive":
			return { alive: false };
		case "kill":
			return { ok: true };
		default:
			return null;
	}
};
let buf = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
	buf += decoder.decode(chunk, { stream: true });
	let nl: number;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		const { id, method, params } = JSON.parse(line);
		process.stdout.write(JSON.stringify({ id, result: answer(method, params ?? {}) }) + "\n");
	}
}

export {};
