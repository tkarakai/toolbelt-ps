// Things you can do with a running process beyond keep/kill:
//   probe  — is a port a web page? (HTTP + HTML) → offer to open it
//   focus  — bring its terminal tab to the front (tmux, Orca, Terminal, iTerm…)
//   peek   — show its recent output (tmux scrollback, Orca terminal, or log file)
import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { cmuxLink } from "../../cmux";
import type { Listen, Row } from "./procs.ts";

// ── HTTP probe ───────────────────────────────────────────────────────────

export interface Probe {
  url: string;
  status: number;
  web: boolean; // HTML page you'd open in a browser (vs. an API / websocket / nothing)
  title?: string;
}

export const urlOf = (l: Listen) => `http://${l.host}:${l.port}/`;

/** One quick GET. Null if it doesn't speak HTTP. */
export async function probe(l: Listen): Promise<Probe | null> {
  const url = urlOf(l);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1200), redirect: "follow", headers: { "user-agent": "running", connection: "close" }, keepalive: false });
    const type = res.headers.get("content-type") ?? "";
    let title: string | undefined;
    if (type.includes("html")) {
      const html = (await res.text()).slice(0, 64_000);
      title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim().replace(/\s+/g, " ") || undefined;
    } else {
      res.body?.cancel().catch(() => {});
    }
    return { url, status: res.status, web: type.includes("html"), title };
  } catch {
    return null;
  }
}

export function openUrl(url: string) {
  Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
}

// ── focus ────────────────────────────────────────────────────────────────

const sh = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: (p.exitCode === 0 ? p.stdout : p.stderr).toString().trim() };
};
const osa = (script: string) => sh(["osascript", "-e", script]);

export type FocusResult = { ok: boolean; message: string; prompt?: string };

/** Bring the process's terminal to the front. May return a command to run instead (tmux attach). */
export function focus(r: Row): FocusResult {
  const t = r.term;
  const tty = r.tty !== "??" ? `/dev/${r.tty}` : "";

  if (t.tmux) {
    const target = sh(["tmux", "display-message", "-p", "-t", t.tmux, "#{session_name}\t#{window_index}"]);
    if (target.ok) {
      const [session, win] = target.out.split("\t");
      if (process.env.TMUX && sh(["tmux", "switch-client", "-t", session!]).ok) {
        sh(["tmux", "select-window", "-t", `${session}:${win}`]);
        sh(["tmux", "select-pane", "-t", t.tmux]);
        return { ok: true, message: `switched to tmux ${session}:${win}` };
      }
      // Outside tmux we can't switch for you — but we can type the attach command.
      return {
        ok: true,
        message: `tmux pane ${session}:${win}`,
        prompt: `tmux attach -t ${session} \\; select-window -t ${session}:${win} \\; select-pane -t ${t.tmux}`,
      };
    }
  }
  const cmux = cmuxLink(t.cmuxworkspace, t.cmuxsurface);
  if (cmux) {
    const res = sh(["open", "-a", "cmux", cmux]);
    return { ok: res.ok, message: res.ok ? "requested its CMUX workspace and surface" : "couldn't open its CMUX surface" };
  }
  if (t.orca) {
    const res = sh(["orca", "terminal", "switch", "--terminal", t.orca]);
    if (res.ok) {
      sh(["open", "-a", "Orca"]);
      return { ok: true, message: "switched to its Orca terminal" };
    }
  }
  if (tty && (t.app === "Apple_Terminal" || r.where === "Terminal")) {
    const res = osa(`tell application "Terminal"
      repeat with w in windows
        repeat with tb in tabs of w
          if tty of tb is "${tty}" then
            set selected tab of w to tb
            set index of w to 1
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end tell`);
    if (res.ok && res.out === "ok") return { ok: true, message: "switched to its Terminal tab" };
  }
  if (tty && (t.app === "iTerm.app" || r.where.startsWith("iTerm"))) {
    const res = osa(`tell application "iTerm2"
      repeat with w in windows
        repeat with tb in tabs of w
          repeat with s in sessions of tb
            if tty of s is "${tty}" then
              select s
              select tb
              select w
              activate
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell`);
    if (res.ok && res.out === "ok") return { ok: true, message: "switched to its iTerm tab" };
  }
  if (tty && (t.app === "ghostty" || r.where === "Ghostty")) {
    const res = osa(`tell application "Ghostty"
      repeat with w in windows
        repeat with tb in tabs of w
          repeat with s in terminals of tb
            if tty of s is "${tty}" then
              focus s
              activate
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell`);
    if (res.ok && res.out === "ok") return { ok: true, message: "switched to its Ghostty tab" };
  }
  if (t.wezterm && sh(["wezterm", "cli", "activate-pane", "--pane-id", t.wezterm]).ok)
    return { ok: true, message: "switched to its WezTerm pane" };
  if (t.kitty && sh(["kitty", "@", "focus-window", "--match", `id:${t.kitty}`]).ok)
    return { ok: true, message: "switched to its kitty window" };

  // Last resort: bring the app forward. VS Code & co. don't expose their terminals.
  const app = r.where.startsWith("tmux") || r.where === "detached" || r.where === "unknown" ? null : r.where;
  if (app && sh(["open", "-a", app]).ok)
    return { ok: true, message: `brought ${app} to the front (it doesn't let other programs pick a terminal tab)` };
  return { ok: false, message: r.where === "detached" ? "detached — it has no terminal" : "don't know how to reach its terminal" };
}

// ── peek ─────────────────────────────────────────────────────────────────

export interface Peek {
  title: string;
  lines: string[];
  sources: string[]; // other things we could show (e.g. one log file per member)
}

// Strip ANSI escapes (colors, cursor moves) and other control chars — they'd break the layout.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
export const clean = (s: string) => s.replace(ANSI, "").replace(/\r(?!\n)/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

function tailFile(path: string, maxLines: number): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8").split("\n").slice(-maxLines - 1).map(clean);
  } finally {
    closeSync(fd);
  }
}

/** Files the row's processes write stdout/stderr to (regular files only). */
export function outputFiles(r: Row): string[] {
  const res = sh(["lsof", "-a", "-d", "1,2", "-Fftn", "-p", r.pids.slice(0, 200).join(",")]);
  const files = new Set<string>();
  let type = "";
  for (const line of res.out.split("\n")) {
    if (line[0] === "t") type = line.slice(1);
    else if (line[0] === "n" && type === "REG") files.add(line.slice(1));
  }
  return [...files];
}

export function peek(r: Row, maxLines: number, source?: string): Peek {
  const files = outputFiles(r);
  const pick = source && files.includes(source) ? source : undefined;
  if (!pick && r.term.tmux) {
    const res = sh(["tmux", "capture-pane", "-p", "-J", "-t", r.term.tmux, "-S", String(-maxLines)]);
    if (res.ok) return { title: `tmux pane ${r.term.tmux}`, lines: trimBlank(res.out.split("\n").map(clean)), sources: files };
  }
  if (!pick && r.term.orca) {
    const res = sh(["orca", "terminal", "read", "--terminal", r.term.orca, "--limit", String(maxLines), "--json"]);
    if (res.ok) {
      try {
        const tail = JSON.parse(res.out).result.terminal.tail as string[];
        return { title: "Orca terminal", lines: trimBlank(tail.map(clean)), sources: files };
      } catch {}
    }
  }
  const file = pick ?? files[0];
  if (file) return { title: file, lines: trimBlank(tailFile(file, maxLines)), sources: files };
  return {
    title: "no output available",
    lines: [
      r.tty !== "??"
        ? `Its output goes straight to a terminal (${r.tty}) that other programs can't read.`
        : "It doesn't write to a file or terminal we can read.",
      r.tty !== "??" ? "Press f to jump to that terminal instead." : "",
    ],
    sources: files,
  };
}

function trimBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  return lines.slice(0, end);
}
