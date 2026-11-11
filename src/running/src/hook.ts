// The zsh side: a preexec hook that records every command line as you typed it,
// with where it was typed (tty, shell pid, directory, terminal identity).
// `running` uses it to name processes whose launcher already exited (`bun dev`
// spawning detached servers), to show the exact typed text (aliases, env
// prefixes, pipes) instead of the kernel's argv, and to find the terminal tab
// a process lives in. It is never used for history navigation.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, openSync, readSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";

const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "running");
export const LOG_FILE = process.env.RUNNING_LOG_FILE ?? join(STATE_DIR, "commands.log");

// Bun text import: bundled into the compiled binary.
import initScript from "./init.zsh" with { type: "text" };
export const SHELL_INIT: string = initScript;

export interface Typed {
  t: number; // epoch seconds (fractional)
  tty: string; // "ttys025"
  shellPid: number;
  cwd: string;
  term: Record<string, string>; // orca/tmux/app/apple/iterm/wezterm/kitty → id (only non-empty)
  cmd: string;
}

const unescape = (s: string) => s.replace(/\\(\\|n|t)/g, (_, ch) => (ch === "n" ? "\n" : ch === "t" ? "\t" : "\\"));

function parseLine(line: string): Typed | null {
  const f = line.split("\t");
  if (f.length < 6) return null;
  const term: Record<string, string> = {};
  for (const kv of f[4]!.split(";")) {
    const i = kv.indexOf("=");
    if (i > 0 && kv.length > i + 1) term[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return {
    t: Number(f[0]), tty: f[1]!.replace(/^\/dev\//, ""), shellPid: Number(f[2]), cwd: f[3]!, term,
    cmd: unescape(f.slice(5).join("\t")),
  };
}

let cache: { mtimeMs: number; size: number; entries: Typed[] } | null = null;
const TAIL_BYTES = 1 << 20; // the last 1 MB is thousands of commands — plenty for live processes

/** Recent entries, oldest first. Cheap to call every refresh (re-read only on change). */
export function readLog(): Typed[] {
  if (!existsSync(LOG_FILE)) return [];
  const fd = openSync(LOG_FILE, "r");
  try {
    const st = fstatSync(fd);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.entries;
    const start = Math.max(0, st.size - TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const entries = text.split("\n").map(parseLine).filter((e): e is Typed => !!e);
    cache = { mtimeMs: st.mtimeMs, size: st.size, entries };
    return entries;
  } finally {
    closeSync(fd);
  }
}

/** Keep the log bounded: drop entries older than `days` once it grows past 5 MB. */
export function pruneLog(days = 30): void {
  try {
    if (!existsSync(LOG_FILE) || statSync(LOG_FILE).size < 5 << 20) return;
    const cutoff = Date.now() / 1000 - days * 86400;
    const kept = readFileSync(LOG_FILE, "utf8").split("\n").filter((l) => Number(l.split("\t")[0]) >= cutoff);
    writeFileSync(LOG_FILE + ".tmp", kept.join("\n") + "\n");
    renameSync(LOG_FILE + ".tmp", LOG_FILE);
  } catch {}
}

/**
 * The command typed on `tty` that started a job at `startedAt`: the last entry
 * on that terminal no later than the job's first process (+ clock slack).
 */
export function typedFor(log: Typed[], tty: string, startedAt: number, shellPid?: number): Typed | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    // preexec runs just before the shell forks, so the entry precedes the process.
    if (e.tty !== tty || e.t > startedAt + 0.05) continue;
    if (shellPid && e.shellPid !== shellPid) continue;
    return startedAt - e.t < 7 * 86400 ? e : undefined;
  }
}

/** Terminal identity of the most recent command on a tty (for focus/peek). */
export function termForTty(log: Typed[], tty: string): Record<string, string> | undefined {
  for (let i = log.length - 1; i >= 0; i--) if (log[i]!.tty === tty) return log[i]!.term;
}

// ── fallback: zsh history (no tty/cwd, so only a guess) ──────────────────────

let histCache: { mtimeMs: number; entries: { t: number; cmd: string }[] } | null = null;

function readHistory(): { t: number; cmd: string }[] {
  const file = process.env.HISTFILE ?? join(homedir(), ".zsh_history");
  try {
    const st = statSync(file);
    if (histCache?.mtimeMs === st.mtimeMs) return histCache.entries;
    const entries: { t: number; cmd: string }[] = [];
    // EXTENDED_HISTORY lines: ": <epoch>:<duration>;<command>" (continuations end with "\")
    const lines = readFileSync(file, "latin1").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^: (\d+):\d+;(.*)$/);
      if (!m) continue;
      let cmd = m[2]!;
      while (cmd.endsWith("\\") && i + 1 < lines.length) cmd = cmd.slice(0, -1) + "\n" + lines[++i];
      entries.push({ t: Number(m[1]), cmd });
    }
    histCache = { mtimeMs: st.mtimeMs, entries };
    return entries;
  } catch {
    return [];
  }
}

/** History entries typed in [from, to] (epoch seconds), newest first. No tty/cwd: any terminal could have typed them. */
export function historyBetween(from: number, to: number): string[] {
  const h = readHistory();
  const out: string[] = [];
  for (let i = h.length - 1; i >= 0; i--) {
    const e = h[i]!;
    if (e.t > to) continue;
    if (e.t < from) break;
    out.push(Buffer.from(e.cmd, "latin1").toString("utf8"));
  }
  return out;
}
