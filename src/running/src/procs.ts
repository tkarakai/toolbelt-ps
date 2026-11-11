// Collects processes and decides which ones a human probably cares about.
//
// The model: the thing you typed into a shell is the "job root". Everything it
// spawns (npm -> sh -> node vite) is folded into that row. Rows come from three
// sources:
//   term   — a direct child of an interactive (tty-attached) shell
//   server — owns a listening TCP socket (folded up through wrappers like npm)
//   daemon — detached (reparented to launchd), user-owned, not an app/system binary
// Listeners that belong to GUI apps or macOS are classified "app" and hidden
// unless "show all" is on.
import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { readFileSync, statSync } from "node:fs";
import { procArgs, procCwd, procPath, procStart } from "./native.ts";
import { historyBetween, readLog, termForTty, typedFor, type Typed } from "./hook.ts";
import { isAppContainer } from "./fingerprint.ts";
import { isCodexAppServer } from "./codex-server.ts";
import { detectAgent } from "../../agents.ts";

export type Kind = "term" | "server" | "daemon" | "app";

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  tty: string; // "??" when none
  etimeSec: number;
  rssKb: number;
  cpu: number;
  stat: string; // ps state: R running, S sleeping, T stopped, U uninterruptible, Z zombie (+ flags)
  comm: string; // from ps; may be truncated or a bare name
}

export interface Listen {
  pid: number; // the process that owns the socket
  port: number;
  host: string; // address to connect to: "localhost", "127.0.0.1", "[::1]", "100.x.y.z"
}

/** One process inside a job (everything but the job's root). Shown as an indented child row. */
export interface Member {
  pid: number;
  ppid: number;
  depth: number; // 0 = directly under the job row
  displayArgv: string[];
  argvCommand: string;
  cwd: string;
  listen: Listen[];
  tty: string;
  stat: string;
  etimeSec: number;
  rssKb: number;
  cpu: number;
  pids: number[]; // this process and its descendants within the job
}

export interface Row {
  pid: number; // the job's root process — for orphaned jobs, the (exited) leader = pgid
  pgid: number;
  kind: Kind;
  argv: string[]; // raw argv from the kernel
  displayArgv: string[]; // shebang-collapsed: `node /…/bin/npm run dev` -> `npm run dev`
  argvCommand: string; // shell-quoted displayArgv
  command: string; // what you typed (from the command log) or else argvCommand
  // where `command` came from: the command log (exact), package-runner variables in
  // the processes' environment (exact script, spelling may differ), a consistent
  // shell-history entry (likely), or the kernel's argv of the earliest member.
  source: "typed" | "script" | "history" | "argv";
  leaderGone: boolean; // the command you ran exited; these are what it left behind
  exe: string;
  cwd: string;
  ports: number[];
  listen: Listen[];
  where: string; // "Orca", "tmux main:2", "Visual Studio Code", "detached"…
  term: Record<string, string>; // terminal identity: orca handle, tmux pane id, TERM_PROGRAM…
  tty: string;
  stat: string; // the root's ps state (for an exited leader: the earliest member's)
  etimeSec: number;
  rssKb: number; // whole subtree
  cpu: number; // whole subtree
  pids: number[]; // all member processes, root first
  members: Member[]; // the job's processes except its root, in tree order
  parentRow?: number; // pid of an enclosing row (e.g. server started by an agent)
  via?: string; // name of non-shell ancestor that launched it
  env: Record<string, string>;
  baseEnv: Record<string, string>; // env of the launching shell, for diffing
  shellPid?: number; // the interactive shell it was typed into (still alive)
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "nu", "tcsh", "ksh", "elvish", "xonsh"]);
// Programs that exist to launch something else. Listeners fold up through these.
const WRAPPERS = new Set([
  "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "deno", "uv", "uvx", "poetry", "pipenv",
  "make", "just", "cargo", "go", "turbo", "nx", "concurrently", "nodemon", "tsx", "ts-node",
  "watchexec", "air", "foreman", "overmind", "hivemind", "honcho", "entr", "env", "nohup",
  "caffeinate", "time", "doppler", "op", "dotenv", "direnv", "mise", "asdf", "rye", "hatch", "pdm",
]);
// Infrastructure that is "detached" by design and never what you're looking for.
const DAEMON_IGNORE = new Set(["tmux", "screen", "zellij", "ssh-agent", "gpg-agent", "launchd", "mosh-server"]);
const INTERPRETERS = /^(node|python[\d.]*|bun|deno|ruby|perl|php|bash|sh|zsh)$/;
// Language runtimes installed under /Library or inside .app bundles run *your* code.
const USER_RUNTIME = /\/(Python|Ruby|Perl)\.framework\/|\/Library\/Developer\/CommandLineTools\/|\/Library\/Java\//;
const SYSTEM_PATH_RE = /^(\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/usr\/bin\/|\/sbin\/|\/bin\/|\/Library\/|\/private\/|\/Applications\/|.*\.app\/|.*\/Library\/)/;
const SYSTEM_PATH = { test: (p: string) => SYSTEM_PATH_RE.test(p) && !USER_RUNTIME.test(p) };

const HOME = homedir();
const MY_UID = process.getuid?.() ?? 501;

export const base = (s: string) => basename(s.replace(/^-/, ""));
const isShell = (p: Proc) => SHELLS.has(base(p.comm));

function parseEtime(s: string): number {
  // [[dd-]hh:]mm:ss
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const parts = rest!.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(d) * 86400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

async function psAll(): Promise<Map<number, Proc>> {
  const out = await run(["ps", "-axo", "pid=,ppid=,pgid=,uid=,tty=,etime=,rss=,%cpu=,stat=,comm="]);
  const map = new Map<number, Proc>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    map.set(pid, {
      pid, ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), tty: m[5]!,
      etimeSec: parseEtime(m[6]!), rssKb: Number(m[7]), cpu: Number(m[8]), stat: m[9]!, comm: m[10]!,
    });
  }
  return map;
}

async function listeners(): Promise<Map<number, Listen[]>> {
  const out = await run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
  const map = new Map<number, Listen[]>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n") {
      const i = line.lastIndexOf(":");
      const port = Number(line.slice(i + 1));
      if (!port) continue;
      const addr = line.slice(1, i);
      const host = addr === "*" || addr === "0.0.0.0" || addr === "[::]" ? "localhost" : addr;
      const list = map.get(pid) ?? [];
      const prev = list.find((l) => l.port === port);
      if (!prev) list.push({ pid, port, host });
      else if (host === "localhost") prev.host = host; // prefer the widest binding
      map.set(pid, list);
    }
  }
  for (const l of map.values()) l.sort((a, b) => a.port - b.port);
  return map;
}

interface Pane { id: string; loc: string }

async function tmuxPanes(): Promise<Map<number, Pane>> {
  // Space-separated: tmux ≥3.5 rewrites tabs in format output to "_".
  const out = await run(["tmux", "list-panes", "-a", "-F", "#{pane_pid} #{pane_id} #{session_name}:#{window_index}.#{pane_index}"]).catch(() => "");
  const map = new Map<number, Pane>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+) (%\d+) (.+)$/);
    if (m) map.set(Number(m[1]), { id: m[2]!, loc: m[3]! });
  }
  return map;
}

function appName(path: string): string | null {
  const m = path.match(/\/([^/]+)\.app\//);
  return m ? m[1]!.replace(/ (Terminal Host|Helper).*$/, "") : null;
}

export function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_\-+=.,/:@%^]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const tildify = (p: string) => (p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);
export const untildify = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p);

/** Undo the kernel's shebang expansion so the command reads like what was typed. */
function collapseShebang(argv: string[], env: Record<string, string>): string[] {
  if (argv.length < 2) return shortenArgv0(argv, env);
  const interp = base(argv[0]!);
  const script = argv[1]!;
  const pathDirs = (env.PATH ?? process.env.PATH ?? "").split(":");
  if (INTERPRETERS.test(interp) && script.startsWith("/") && pathDirs.includes(dirname(script)))
    return [basename(script), ...argv.slice(2)];
  return shortenArgv0(argv, env);
}

/** `/long/vendor/path/codex …` -> `codex …` when that name is on PATH (it's what was typed). */
function shortenArgv0(argv: string[], env: Record<string, string>): string[] {
  const a0 = argv[0] ?? "";
  if (!a0.startsWith("/")) return argv;
  // macOS framework Python re-execs itself as …/Python.app/Contents/MacOS/Python.
  if (/\/Python\.app\/Contents\/MacOS\/Python$/.test(a0)) return ["python3", ...argv.slice(1)];
  const name = basename(a0);
  const found = Bun.which(name, { PATH: env.PATH ?? process.env.PATH ?? "" });
  // exact-case match: the filesystem is case-insensitive, `Python` would find `python`
  if (found && basename(found) === name) return [name, ...argv.slice(1)];
  return argv;
}

const TERM_ENV: [string, string][] = [
  ["CMUX_WORKSPACE_ID", "cmuxworkspace"], ["CMUX_SURFACE_ID", "cmuxsurface"],
  ["ORCA_TERMINAL_HANDLE", "orca"], ["TMUX_PANE", "tmux"], ["TERM_PROGRAM", "app"],
  ["TERM_SESSION_ID", "apple"], ["ITERM_SESSION_ID", "iterm"], ["WEZTERM_PANE", "wezterm"], ["KITTY_WINDOW_ID", "kitty"],
];

export async function collect(opts: { selfPid: number }): Promise<Row[]> {
  const [procs, listen, panes] = await Promise.all([psAll(), listeners(), tmuxPanes()]);
  const log = readLog();
  const now = Date.now() / 1000;

  const children = new Map<number, number[]>();
  for (const p of procs.values()) {
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  const subtree = (pid: number): number[] => {
    const out = [pid];
    for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!) ?? []));
    return out;
  };

  // Never list ourselves (or the ps/lsof we spawn).
  // …including whatever launched us (`bun run dev`), up to the shell.
  const excluded = new Set(subtree(opts.selfPid));
  for (let cur = procs.get(procs.get(opts.selfPid)?.ppid ?? 0); cur && cur.pid > 1 && !isShell(cur); cur = procs.get(cur.ppid))
    excluded.add(cur.pid);

  const exeCache = new Map<number, string>();
  const exeOf = (pid: number) => {
    if (!exeCache.has(pid)) exeCache.set(pid, procPath(pid) ?? procs.get(pid)?.comm ?? "");
    return exeCache.get(pid)!;
  };
  const argsCache = new Map<number, ReturnType<typeof procArgs>>();
  const argsOf = (pid: number) => {
    if (!argsCache.has(pid)) argsCache.set(pid, procArgs(pid));
    return argsCache.get(pid)!;
  };
  const isWrapper = (pid: number) => {
    const p = procs.get(pid);
    if (!p) return false;
    const a = argsOf(pid);
    const argv = a ? collapseShebang(a.argv, a.env) : [p.comm];
    return WRAPPERS.has(base(argv[0] ?? p.comm));
  };
  // A shell you type into — not `bash ./dev-start.sh` or `sh -c "…"` on the same terminal.
  const interactiveCache = new Map<number, boolean>();
  const interactiveShell = (pid: number) => {
    const p = procs.get(pid);
    if (!p || !isShell(p) || p.tty === "??") return false;
    if (!interactiveCache.has(pid)) {
      const argv = argsOf(pid)?.argv ?? [];
      let interactive = true;
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "-c") { interactive = false; break; }
        if (a.startsWith("-") || a.startsWith("+")) { if (a === "-o" || a === "+o") i++; continue; }
        interactive = false; // a positional argument: a script file
        break;
      }
      interactiveCache.set(pid, interactive);
    }
    return interactiveCache.get(pid)!;
  };

  // The outermost interactive shell on each terminal: where orphaned jobs were typed.
  const shellByTty = new Map<string, number>();
  for (const p of procs.values())
    if (p.uid === MY_UID && interactiveShell(p.pid) && !interactiveShell(p.ppid) && !shellByTty.has(p.tty)) shellByTty.set(p.tty, p.pid);

  const roots = new Map<number, Kind>();
  const claimed = new Set<number>(); // members of orphaned jobs

  // 0. Orphaned jobs: process groups whose leader exited. Job control gives every
  //    command line its own group, and members keep it after being reparented.
  const groups = new Map<number, number[]>();
  for (const p of procs.values()) {
    if (p.uid !== MY_UID || excluded.has(p.pid) || p.pgid <= 1 || procs.has(p.pgid)) continue;
    groups.set(p.pgid, [...(groups.get(p.pgid) ?? []), p.pid]);
  }
  const orphanJobs = new Map<number, number[]>();
  for (const [g, members] of groups) {
    if (!members.some((m) => procs.get(m)!.tty !== "??")) continue; // not from a terminal
    if (members.some((m) => interactiveShell(procs.get(m)!.ppid))) continue; // pipeline still attached: a term job
    const all = [...new Set(members.flatMap(subtree))];
    orphanJobs.set(g, all);
    for (const m of all) claimed.add(m);
  }

  // 1. Terminal jobs.
  for (const p of procs.values()) {
    if (p.uid !== MY_UID || excluded.has(p.pid) || claimed.has(p.pid) || interactiveShell(p.pid)) continue;
    if (interactiveShell(p.ppid) && p.tty !== "??") roots.set(p.pid, "term");
  }

  // 2. Listeners, folded up through wrappers to the job root.
  for (const [pid] of listen) {
    const p = procs.get(pid);
    if (!p || excluded.has(pid) || claimed.has(pid)) continue;
    let root = pid;
    while (true) {
      const parent = procs.get(procs.get(root)!.ppid);
      if (!parent || parent.pid <= 1 || parent.uid !== p.uid || isShell(parent) || !isWrapper(parent.pid)) break;
      root = parent.pid;
    }
    if (roots.has(root)) continue; // already a terminal job; ports attach below
    const sysOrApp = p.uid !== MY_UID || SYSTEM_PATH.test(exeOf(pid));
    roots.set(root, sysOrApp ? "app" : "server");
  }

  // 3. Detached user daemons (nohup'd, disowned, brew services…).
  for (const p of procs.values()) {
    if (p.uid !== MY_UID || p.ppid !== 1 || p.tty !== "??" || excluded.has(p.pid) || claimed.has(p.pid) || roots.has(p.pid)) continue;
    if (SYSTEM_PATH.test(exeOf(p.pid)) || DAEMON_IGNORE.has(base(exeOf(p.pid)))) continue;
    roots.set(p.pid, "daemon");
  }

  // GUI clients launch agent harnesses over stdio, without a tty, TCP
  // listener, or launchd parent. Keep recognized harnesses as their own jobs.
  for (const p of procs.values()) {
    if (p.uid !== MY_UID || excluded.has(p.pid) || claimed.has(p.pid) || roots.has(p.pid)) continue;
    const a = argsOf(p.pid);
    if (!a) continue;
    const argv = collapseShebang(a.argv, a.env);
    const agent = detectAgent(argv, exeOf(p.pid));
    if (!agent) continue;
    // Codex's package also contains worker binaries; those aren't harnesses.
    if (agent.id === "codex" && base(argv[0] ?? "") !== "codex" && base(exeOf(p.pid)) !== "codex") continue;
    if (agent.id === "codex" && argv[1] === "app-server" && !isCodexAppServer(argv)) continue;
    roots.set(p.pid, "daemon");
  }

  const rootSet = new Set([...roots.keys(), ...orphanJobs.keys()]);

  /** Walk up from `start`: nearest enclosing row, launching program, host location, shell. */
  const locate = (start: number | undefined, self: number) => {
    let parentRow: number | undefined, via: string | undefined, where = "", shellPid: number | undefined, pane: Pane | undefined;
    for (let cur = start ? procs.get(start) : undefined; cur && cur.pid > 1; cur = procs.get(cur.ppid)) {
      if (cur.pid !== self && parentRow === undefined && rootSet.has(cur.pid)) parentRow = cur.pid;
      if (isShell(cur)) {
        shellPid ??= cur.pid;
        const pn = panes.get(cur.pid);
        if (pn && !where) { where = `tmux ${pn.loc}`; pane = pn; }
        continue;
      }
      const b = base(cur.comm);
      if (cur.pid !== self && !via && b !== "login") via = b;
      if (b === "tmux" && !where) where = "tmux";
      if (b === "sshd" && !where) where = "ssh";
      const app = appName(exeOf(cur.pid));
      if (app && !where) where = app;
      if (!where && b.includes("orca")) where = "Orca";
    }
    return { parentRow, via, where, shellPid, pane };
  };

  const termOf = (tty: string, env: Record<string, string>, pane?: Pane) => {
    const term: Record<string, string> = { ...(tty !== "??" ? termForTty(log, tty) : undefined) };
    for (const [k, short] of TERM_ENV) if (env[k] && !term[short]) term[short] = env[k]!;
    if (pane) term.tmux = pane.id;
    return term;
  };

  const sum = (pids: number[]) => {
    let rss = 0, cpu = 0;
    for (const x of pids) { const q = procs.get(x); if (q) { rss += q.rssKb; cpu += q.cpu; } }
    return { rss, cpu };
  };
  const listenOf = (pids: number[]) => pids.flatMap((x) => listen.get(x) ?? []).sort((a, b) => a.port - b.port);
  const argvFor = (pid: number) => {
    const p = procs.get(pid)!;
    const a = argsOf(pid);
    // Some programs overwrite their argv (setproctitle); drop the empty padding.
    const argv = (a?.argv ?? [p.comm]).filter((s, i) => i === 0 || s !== "");
    const env = a?.env ?? {};
    const displayArgv = collapseShebang(argv, env);
    return { argv, env, displayArgv, argvCommand: displayArgv.map(shellQuote).join(" ") };
  };

  /** Tree-ordered members (excluding `root`, which may be an exited leader). */
  const membersOf = (pids: number[], root: number): Member[] => {
    const set = new Set(pids);
    set.delete(root);
    const kids = new Map<number, number[]>();
    const tops: number[] = [];
    for (const x of set) {
      const pp = procs.get(x)!.ppid;
      if (set.has(pp)) kids.set(pp, [...(kids.get(pp) ?? []), x]);
      else tops.push(x);
    }
    const byStart = (a: number, b: number) => procs.get(b)!.etimeSec - procs.get(a)!.etimeSec || a - b;
    const out: Member[] = [];
    const walk = (x: number, depth: number): number[] => {
      const p = procs.get(x)!;
      const { displayArgv, argvCommand } = argvFor(x);
      const m: Member = {
        pid: x, ppid: p.ppid, depth, displayArgv, argvCommand, cwd: procCwd(x) ?? "",
        listen: (listen.get(x) ?? []).slice(), tty: p.tty, stat: p.stat, etimeSec: p.etimeSec, rssKb: p.rssKb, cpu: p.cpu, pids: [x],
      };
      out.push(m);
      for (const c of (kids.get(x) ?? []).sort(byStart)) m.pids.push(...walk(c, depth + 1));
      return m.pids;
    };
    for (const t of tops.sort(byStart)) walk(t, 0);
    return out;
  };

  const rows: Row[] = [];

  for (const [pid, kind] of roots) {
    const p = procs.get(pid)!;
    // Subtree, stopping at nested rows (they're listed on their own).
    const pids = [pid];
    for (let i = 0; i < pids.length; i++)
      for (const c of children.get(pids[i]!) ?? []) if (!rootSet.has(c)) pids.push(c);

    const { argv, env, displayArgv, argvCommand } = argvFor(pid);
    const loc = locate(p.ppid, pid);
    let where = loc.where;
    if (!where) {
      const app = appName(exeOf(pid));
      where = kind === "app" ? app ?? "macOS" : kind === "daemon" || p.ppid === 1 ? "detached" : app ?? loc.via ?? "unknown";
    }
    // A shell's own child: "via" would just be the terminal host; keep it only when interesting.
    let via = loc.via;
    if (kind === "term" || via === where || (via && where.toLowerCase().includes(via.toLowerCase()))) via = undefined;

    // What was actually typed (aliases, env prefixes, pipes) — only for direct shell children.
    const typed: Typed | undefined =
      kind === "term" && p.tty !== "??" ? typedFor(log, p.tty, procStart(pid) ?? now - p.etimeSec, p.ppid) : undefined;
    const ls = listenOf(pids);
    const { rss, cpu } = sum(pids);

    rows.push({
      pid, pgid: p.pgid, kind, argv, displayArgv, argvCommand,
      command: typed?.cmd ?? argvCommand, source: typed ? "typed" : "argv", leaderGone: false,
      exe: exeOf(pid), cwd: procCwd(pid) ?? "", ports: ls.map((l) => l.port), listen: ls,
      where, term: termOf(p.tty, env, loc.pane), tty: p.tty, stat: p.stat,
      etimeSec: p.etimeSec, rssKb: rss, cpu, pids, members: membersOf(pids, pid), parentRow: loc.parentRow, via, env,
      baseEnv: (loc.shellPid && argsOf(loc.shellPid)?.env) || {},
      shellPid: kind === "term" && interactiveShell(p.ppid) ? p.ppid : undefined,
    });
  }

  for (const [pgid, pids] of orphanJobs) {
    // The earliest surviving member stands in for the exited leader.
    const startOf = (x: number) => procStart(x) ?? now - procs.get(x)!.etimeSec;
    const first = pids.map((x) => procs.get(x)!).sort((a, b) => startOf(a.pid) - startOf(b.pid) || a.pid - b.pid)[0]!;
    const tty = pids.map((x) => procs.get(x)!.tty).find((t) => t !== "??")!;
    const startedAt = startOf(first.pid);
    const shell = shellByTty.get(tty);
    const loc = locate(shell, -1);
    const typed = typedFor(log, tty, startedAt, shell);
    const { argv, env, displayArgv, argvCommand } = argvFor(first.pid);
    const recent = typed ? [] : historyBetween(startedAt - 600, startedAt + 1);
    // Package scripts (`bun dev`, `npm run dev`) leave proof in every child's environment.
    const script = typed ? undefined : inferScript(pids.map((x) => argsOf(x)?.env ?? {}), recent);
    // Otherwise a history entry, but only one that names a program actually among the members.
    const guess = typed || script ? undefined : recent.find((h) => explains(h, pids.map((x) => argvFor(x).displayArgv)));
    const command = typed?.cmd ?? script?.command ?? guess ?? argvCommand;
    const source: Row["source"] = typed ? "typed" : script ? "script" : guess ? "history" : "argv";
    const ls = listenOf(pids);
    const { rss, cpu } = sum(pids);

    rows.push({
      pid: pgid, pgid, kind: "term", argv, displayArgv: source === "argv" ? displayArgv : command.split(/\s+/), argvCommand,
      command, source, leaderGone: true,
      exe: exeOf(first.pid), cwd: typed?.cwd ?? script?.dir ?? guessCwd(pids.map(procCwd), shell ? procCwd(shell) : null),
      ports: ls.map((l) => l.port), listen: ls,
      where: loc.where || (shell ? "terminal" : "detached"),
      term: termOf(tty, Object.assign({}, ...pids.map((x) => argsOf(x)?.env ?? {}).reverse()), loc.pane), tty, stat: first.stat,
      etimeSec: first.etimeSec, rssKb: rss, cpu, pids, members: membersOf(pids, pgid), env,
      baseEnv: (shell && argsOf(shell)?.env) || {},
      shellPid: shell,
    });
  }

  return rows;
}

const RUNNERS: Record<string, string> = { "bun": "bun", "npm-cli.js": "npm", "npm": "npm", "pnpm.cjs": "pnpm", "pnpm": "pnpm", "yarn.js": "yarn", "yarn.cjs": "yarn", "yarn": "yarn" };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `bun dev` / `npm run dev` / `pnpm dev` from package-runner variables
 * (npm_lifecycle_event, npm_execpath, npm_config_local_prefix). If shell history
 * has a matching line around that time, use your spelling (and extra arguments).
 */
export function inferScript(envs: Record<string, string>[], history: string[]): { command: string; dir?: string } | undefined {
  const e = envs.find((x) => x.npm_lifecycle_event);
  if (!e) return undefined;
  const event = e.npm_lifecycle_event!;
  const agent = e.npm_config_user_agent?.split("/")[0];
  const runner = (agent && RUNNERS[agent]) ?? RUNNERS[basename(e.npm_execpath ?? "")] ?? "npm";
  const dir = e.npm_config_local_prefix ?? (e.npm_package_json ? dirname(e.npm_package_json) : undefined);
  const spelled = history.find((h) => new RegExp(`^${runner}\\s+(run\\s+)?${escapeRe(event)}(\\s|$)`).test(h.trim()));
  if (spelled) return { command: spelled.trim(), dir };
  const command =
    runner === "npm" ? (/^(start|test|stop|restart)$/.test(event) ? `npm ${event}` : `npm run ${event}`)
    : runner === "bun" ? `bun run ${event}`
    : `${runner} ${event}`;
  return { command, dir };
}

/** Does a history line plausibly describe these processes? Its program must appear among them. */
export function explains(line: string, members: string[][]): boolean {
  const words = line.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const prog = basename(words[0] ?? "").toLowerCase();
  if (!prog || ["cd", "ls", "git", "echo", "cat", "clear", "exit"].includes(prog)) return false;
  return members.some((argv) => argv.some((a) => basename(a).toLowerCase() === prog));
}

const branchCache = new Map<string, { at: number; branch: string | null }>();

/** Git branch of the repo (or worktree) containing `dir`, or a short sha when detached. */
export function gitBranch(dir: string): string | null {
  if (isAppContainer(dir)) return null;
  const hit = branchCache.get(dir);
  if (hit && Date.now() - hit.at < 10_000) return hit.branch;
  let branch: string | null = null;
  try {
    for (let d = dir; d && d !== "/"; d = dirname(d)) {
      const dotgit = `${d}/.git`;
      let gitdir: string | null = null;
      try {
        const st = statSync(dotgit);
        gitdir = st.isDirectory() ? dotgit : readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() ?? null;
      } catch { continue; }
      if (!gitdir) break;
      if (!gitdir.startsWith("/")) gitdir = `${d}/${gitdir}`;
      const head = readFileSync(`${gitdir}/HEAD`, "utf8").trim();
      branch = head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 8);
      break;
    }
  } catch {}
  branchCache.set(dir, { at: Date.now(), branch });
  return branch;
}

/** Deepest directory containing all of `dirs`. */
function commonDir(dirs: string[]): string {
  if (!dirs.length) return "";
  let parts = dirs[0]!.split("/");
  for (const d of dirs.slice(1)) {
    const q = d.split("/");
    let i = 0;
    while (i < parts.length && i < q.length && parts[i] === q[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join("/") || "/";
}

/**
 * Where an exited command was probably typed: the members' common directory,
 * widened to include the shell's current directory when that's still specific
 * (scripts often `cd` into subdirectories; the shell usually stays put).
 */
function guessCwd(memberCwds: (string | null)[], shellCwd: string | null): string {
  const dirs = memberCwds.filter((d): d is string => !!d);
  const members = commonDir(dirs);
  if (!shellCwd) return members;
  const both = commonDir([...dirs, shellCwd]);
  return both === "/" || both === HOME || both.split("/").length < 4 ? members : both;
}

/** Kill a row: its process group (if the leader is gone) and its whole subtree, children first. */
export function killRow(r: Row, signal: NodeJS.Signals): number {
  let n = 0;
  const pids = [...r.pids].reverse().filter((pid) => !(r.leaderGone && pid === r.pgid));
  if (r.leaderGone) try { process.kill(-r.pgid, signal); n++; } catch {}
  for (const pid of pids) {
    try { process.kill(pid, signal); n++; } catch {}
  }
  if (signal === "SIGTERM") resume(r.leaderGone ? [-r.pgid, ...pids] : pids);
  return n;
}

/** A stopped (Ctrl-Z, state T) process only acts on SIGTERM once it's continued. */
function resume(pids: number[]) {
  for (const pid of pids) try { process.kill(pid, "SIGCONT"); } catch {}
}

/** Kill a set of processes (e.g. one child of a job and its descendants), children first. */
export function killPids(pids: number[], signal: NodeJS.Signals): number {
  let n = 0;
  for (const pid of [...pids].reverse()) {
    try { process.kill(pid, signal); n++; } catch {}
  }
  if (signal === "SIGTERM") resume(pids);
  return n;
}

/** Why a process may survive `kill -9`, from its ps state. Null if it should just die. */
export function unkillableReason(pid: number): string | null {
  const p = Bun.spawnSync(["ps", "-o", "stat=,ppid=", "-p", String(pid)], { stdout: "pipe" });
  const [stat = "", ppid = ""] = p.stdout.toString().trim().split(/\s+/);
  if (!stat) return null;
  if (stat.startsWith("Z")) {
    const parent = Bun.spawnSync(["ps", "-o", "comm=", "-p", ppid], { stdout: "pipe" }).stdout.toString().trim();
    return `it's a zombie — already dead, using no memory or CPU; it goes away when its parent (pid ${ppid}${parent ? ` ${basename(parent)}` : ""}) collects it or exits`;
  }
  if (stat.startsWith("U") || stat.startsWith("D"))
    return "it's stuck in the kernel (waiting on a disk, network mount or driver) — nothing can stop it until that wait ends";
  return null;
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
