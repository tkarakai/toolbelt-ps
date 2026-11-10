// Starting a kept process. Two ways, both "as if you typed it":
//  - prompt: the TUI exits, the `running` shell function cd's to the directory
//    and puts the command on your prompt (zsh `print -z`), ready to edit/Enter.
//  - tmux:   a new tmux window opens in the directory and the command is typed
//    into it, so it lands in that shell's history and survives the TUI.
import { shellQuote, tildify, untildify } from "./procs.ts";
import type { Kept } from "./store.ts";
import { writeFileSync } from "node:fs";

/** The full line to type: env prefix + command. */
export function commandLine(k: Kept): string {
  const env = Object.entries(k.env ?? {}).map(([key, v]) => `${key}=${shellQuote(v)}`);
  return [...env, k.command].join(" ");
}

export const ACTION_FILE = process.env.RUNNING_ACTION_FILE;

/** Hand a directory + command line to the wrapping shell function. False if not wrapped. */
export function promptLine(dir: string, line: string): boolean {
  if (!ACTION_FILE) return false;
  writeFileSync(ACTION_FILE, `${dir}\n${line}\n`);
  return true;
}

export const toPrompt = (k: Kept) => promptLine(untildify(k.cwd), commandLine(k));

/**
 * How "put this on my prompt" works in the terminal `running` was started from:
 *  shell — the `running` shell function is loaded: it cd's and puts the line on the prompt
 *  type  — no shell function, but we're in Orca or tmux: type `cd … && line` into this terminal
 *  copy  — neither: copy it to the clipboard and print it
 */
export const HANDOFF: "shell" | "type" | "copy" = ACTION_FILE
  ? "shell"
  : process.env.ORCA_TERMINAL_HANDLE || process.env.TMUX_PANE ? "type" : "copy";

const pathArg = (p: string) => (/^[\w./~+-]+$/.test(tildify(p)) ? tildify(p) : shellQuote(p));

/** Hand a command to the user's shell (see HANDOFF). Call right before the TUI exits. */
export function handOff(dir: string, line: string): { how: typeof HANDOFF; full: string } {
  if (promptLine(dir, line)) return { how: "shell", full: line };
  const full = dir ? `cd ${pathArg(dir)} && ${line}` : line;
  if (HANDOFF === "type") {
    // Typed after we've exited and the shell has its prompt back; no Enter — you review it.
    const send = process.env.ORCA_TERMINAL_HANDLE
      ? `orca terminal send --terminal "$RUNNING_TERM" --text "$RUNNING_LINE"`
      : `tmux send-keys -t "$RUNNING_TERM" -l "$RUNNING_LINE"`;
    const p = Bun.spawn(["/bin/sh", "-c", `(sleep 0.7; ${send}) >/dev/null 2>&1 &`], {
      env: { ...process.env, RUNNING_TERM: process.env.ORCA_TERMINAL_HANDLE ?? process.env.TMUX_PANE ?? "", RUNNING_LINE: full },
      stdout: "ignore", stderr: "ignore",
    });
    p.unref();
    return { how: "type", full };
  }
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(full) });
  return { how: "copy", full };
}

function tmux(args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: (p.exitCode === 0 ? p.stdout : p.stderr).toString().trim() };
}

const SESSION = "running";

/** Open a tmux window in the kept dir and type the command. Returns a status message. */
export function toTmux(k: Kept): { ok: boolean; message: string } {
  if (!Bun.which("tmux")) return { ok: false, message: "tmux is not installed" };
  const cwd = untildify(k.cwd);
  const name = k.name.replace(/[.:]/g, "-").slice(0, 30);
  const inside = !!process.env.TMUX;
  let pane: { ok: boolean; out: string };
  if (inside) {
    pane = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, "-n", name]);
  } else if (tmux(["has-session", "-t", SESSION]).ok) {
    pane = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${SESSION}:`, "-c", cwd, "-n", name]);
  } else {
    pane = tmux(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", SESSION, "-c", cwd, "-n", name]);
  }
  if (!pane.ok) return { ok: false, message: `tmux: ${pane.out}` };
  const sent = tmux(["send-keys", "-t", pane.out, "-l", commandLine(k)]);
  if (!sent.ok) return { ok: false, message: `tmux: ${sent.out}` };
  tmux(["send-keys", "-t", pane.out, "Enter"]);
  return {
    ok: true,
    message: inside
      ? `started in tmux window "${name}"`
      : `started in tmux session "${SESSION}", window "${name}" — attach: tmux attach -t ${SESSION}`,
  };
}
