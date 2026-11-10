// Putting running's terminal UI (bundled with this plugin) on the person's PATH, and its zsh hook
// in ~/.zshrc. The two belong together: the hook line, eval "$(command running init)", runs the
// `running` command, so it only works once that command is on PATH.
//
//   install  writes ~/.local/bin/running, a two-line sh wrapper that runs the bundled TUI with
//            this Bun (Toolbelt's own, in the app), so it works without Bun installed; then adds
//            to ~/.zshrc what's missing: an `export PATH=…` line (when ~/.local/bin isn't on the
//            PATH a new terminal gets, or another `running` comes first) and the hook line.
//   remove   deletes exactly what install added: the wrapper (only if it carries MARK) and the
//            ~/.zshrc lines ending with MARK; puts back a `running` that install moved aside.
//   probe    asks a new login shell (zsh -lic, clean PATH, like a new terminal window) which
//            `running` it finds, its version, and whether the hook loaded.
//
// Every path derives from `home` — TOOLBELT_PS_HOME, else the real one — so tests use temp homes.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const MARK = "# added by Toolbelt";
export const HOOK = `eval "$(command running init)"`;
export const PATH_LINE = `export PATH="$HOME/.local/bin:$PATH"`;
/** What a terminal opened from the Dock starts with, before the login shell's files. */
const BASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export const homeDir = (env: Record<string, string | undefined> = process.env) => env.TOOLBELT_PS_HOME || homedir();

export type Paths = { home: string; binDir: string; wrapper: string; backup: string; zshrc: string };
export function pathsFor(home: string): Paths {
	const binDir = join(home, ".local/bin");
	const wrapper = join(binDir, "running");
	return { home, binDir, wrapper, backup: `${wrapper}.before-toolbelt`, zshrc: join(home, ".zshrc") };
}

/** Installed packages resolve the active immutable version on every invocation. */
export function wrapperScript(bun: string, tui: string, configDir = process.env.TOOLBELT_PACKAGE_ROOT ? process.env.TOOLBELT_CONFIG_DIR : undefined) {
 if (!configDir) return `#!/bin/sh\n${MARK}: running's terminal UI, bundled with Toolbelt (Processes › Settings removes it).\nexec ${sq(bun)} ${sq(tui)} "$@"\n`;
 const resolver = `const fs=require("node:fs"),path=require("node:path");const root=process.argv[1];try {const record=JSON.parse(fs.readFileSync(path.join(root,"plugins/registry.json"),"utf8")).plugins.processes;if(!record?.enabled)throw Error("Processes is disabled or removed; enable it in Toolbelt.");const file=path.join(record.packageRoot,"payload/bin/running");if(!fs.existsSync(file))throw Error("Processes TUI payload is unavailable.");const proc=Bun.spawn([process.execPath,file,...process.argv.slice(2)],{stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,RUNNING_CONFIG_DIR:path.join(root,"data/processes/running"),RUNNING_LOG_FILE:path.join(root,"data/processes/commands.log")}});process.exit(await proc.exited);}catch(e){console.error(e.message);process.exit(1);}`;
 return `#!/bin/sh\n${MARK}: active Processes package resolver (Processes › Settings removes it).\nexec ${sq(bun)} -e ${sq(resolver)} ${sq(configDir)} "$@"\n`;
}
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** missing · current (ours, runs this bundle) · stale (ours, runs another: an older or moved app) · foreign (not ours). */
export type WrapperState = "missing" | "current" | "stale" | "foreign";
export function wrapperState(p: Paths, bun: string, tui: string): WrapperState {
	if (!existsSync(p.wrapper)) return "missing";
	let text = "";
	try {
		text = readFileSync(p.wrapper, "utf8");
	} catch {
		return "foreign";
	}
	if (!text.includes(MARK)) return "foreign";
	return text === wrapperScript(bun, tui) ? "current" : "stale";
}

const isOurs = (line: string) => line.trimEnd().endsWith(MARK);
const isHook = (line: string) => /^\s*[^#\s].*\brunning\s+init\b/.test(line);

export type Zshrc = { exists: boolean; hook: "toolbelt" | "yours" | "none"; pathLine: boolean; ourLines: number };
export function readZshrc(p: Paths): Zshrc {
	let text: string | null = null;
	try {
		text = readFileSync(p.zshrc, "utf8");
	} catch {}
	const lines = (text ?? "").split("\n");
	const ours = lines.filter(isOurs);
	return {
		exists: text !== null,
		hook: ours.some(isHook) ? "toolbelt" : lines.some((l) => !isOurs(l) && isHook(l)) ? "yours" : "none",
		pathLine: ours.some((l) => l.includes("PATH=")),
		ourLines: ours.length,
	};
}

export type Probe =
	| { ok: true; pathDirs: string[]; found: string[]; version?: string; hookLoaded: boolean }
	| { ok: false; error: string };

const PROBE = [
	`print -r -- "@@tb path=$PATH"`,
	`print -r -- "@@tb kind=$(whence -w running)"`,
	`whence -pa running | while IFS= read -r p; do print -r -- "@@tb found=$p"; done`,
	`p=$(whence -p running) && print -r -- "@@tb version=$("$p" --version 2>/dev/null | head -n 1)"`,
	`exit 0`,
].join("\n");

/** What a new terminal sees: `zsh -lic` in `home`, starting from the PATH the Dock gives. */
export async function probe(home: string, timeoutMs = 10_000): Promise<Probe> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ZDOTDIR" && k !== "RUNNING_ACTION_FILE") env[k] = v;
	Object.assign(env, { HOME: home, PATH: BASE_PATH });
	try {
		const proc = Bun.spawn(["/bin/zsh", "-lic", PROBE], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		const vals = (key: string) => out.split("\n").filter((l) => l.startsWith(`@@tb ${key}=`)).map((l) => l.slice(key.length + 6));
		const [path] = vals("path");
		if (path === undefined) {
			const why = proc.signalCode ? `no answer within ${Math.round(timeoutMs / 1000)} s` : err.trim().split("\n").pop() || `exit ${proc.exitCode}`;
			return { ok: false, error: `zsh didn't answer: ${why}` };
		}
		return { ok: true, pathDirs: path.split(":").filter(Boolean), found: vals("found"), version: vals("version")[0] || undefined, hookLoaded: /: function$/.test(vals("kind")[0] ?? "") };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

/** Whether install should add the PATH line: ~/.local/bin isn't on a new terminal's PATH, or
 *  another `running` comes before it. Unknown (the probe failed): add it — it's harmless. */
export function needsPathLine(p: Paths, pr: Probe | null): boolean {
	if (!pr?.ok) return true;
	const norm = (d: string) => resolve(d);
	const at = pr.pathDirs.map(norm).indexOf(norm(p.binDir));
	if (at < 0) return true;
	return pr.found.some((f) => {
		const i = pr.pathDirs.map(norm).indexOf(norm(dirname(f)));
		return i >= 0 && i < at;
	});
}

export type Result = { ok: boolean; message: string; changes: string[] };

export function install(opts: { home: string; bun: string; tui: string; probe: Probe | null }): Result {
	const p = pathsFor(opts.home);
	const changes: string[] = [];
	const state = wrapperState(p, opts.bun, opts.tui);
	if (state === "foreign") {
		if (existsSync(p.backup)) return { ok: false, message: `${p.backup} is in the way — move it, then try again`, changes };
		renameSync(p.wrapper, p.backup);
		changes.push(`moved the existing ${p.wrapper} to ${p.backup}`);
	}
	if (state !== "current") {
		mkdirSync(p.binDir, { recursive: true });
		writeFileSync(p.wrapper, wrapperScript(opts.bun, opts.tui));
		chmodSync(p.wrapper, 0o755);
		changes.push(`${state === "stale" ? "updated" : "wrote"} ${p.wrapper}`);
	}
	const z = readZshrc(p);
	const add: string[] = [];
	if (!z.pathLine && needsPathLine(p, opts.probe)) add.push(`${PATH_LINE} ${MARK}`);
	if (z.hook === "none") add.push(`${HOOK} ${MARK}`);
	if (add.length) {
		let text = z.exists ? readFileSync(p.zshrc, "utf8") : "";
		if (text && !text.endsWith("\n")) text += "\n";
		writeFileSync(p.zshrc, text + add.map((l) => l + "\n").join(""));
		changes.push(`added ${add.length} line${add.length > 1 ? "s" : ""} to ${p.zshrc}`);
	}
	return { ok: true, message: changes.length ? "Installed — open a new terminal and run `running`" : "Already installed", changes };
}

export function remove(opts: { home: string }): Result {
	const p = pathsFor(opts.home);
	const changes: string[] = [];
	const ours = existsSync(p.wrapper) && (() => {
		try {
			return readFileSync(p.wrapper, "utf8").includes(MARK);
		} catch {
			return false;
		}
	})();
	if (ours) {
		rmSync(p.wrapper);
		changes.push(`deleted ${p.wrapper}`);
		if (existsSync(p.backup)) {
			renameSync(p.backup, p.wrapper);
			changes.push(`put back ${p.wrapper} (from ${p.backup})`);
		}
	}
	if (existsSync(p.zshrc)) {
		const text = readFileSync(p.zshrc, "utf8");
		const lines = text.split("\n");
		const kept = lines.filter((l) => !isOurs(l));
		if (kept.length !== lines.length) {
			writeFileSync(p.zshrc, kept.join("\n"));
			changes.push(`removed ${lines.length - kept.length} line${lines.length - kept.length > 1 ? "s" : ""} from ${p.zshrc}`);
		}
	}
	return { ok: true, message: changes.length ? "Removed — new terminals won't have Toolbelt's `running`" : "Nothing of Toolbelt's to remove", changes };
}
