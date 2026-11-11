// Restart = stop the whole job, then run its command again — in the same
// terminal when we can type into it (tmux pane, Orca terminal), otherwise in a
// new tmux window or at your prompt.
import { isAlive, killRow, shellQuote, tildify, untildify, type Row } from "./procs.ts";
import { procCwd } from "./native.ts";
import { agentInfo, resumeLine } from "./agents.ts";
import { commandLine, toTmux } from "./launch.ts";
import type { Kept } from "./store.ts";
import { realpathSync } from "node:fs";

export interface RestartPlan {
  line: string; // what gets typed
  cwd: string;
  where: "tmux" | "orca" | "new-tmux" | "prompt";
  whereLabel: string;
  exact: boolean; // false when the command is reconstructed (argv) or guessed (history)
  why: string; // where the command came from
}

export type PlanResult = { ok: true; plan: RestartPlan } | { ok: false; reason: string };

/** Work out what a restart would do, without doing anything. */
export function planRestart(r: Row, kept?: Kept): PlanResult {
  let line: string | undefined, cwd = r.cwd, exact = true, why = "";
  const agent = agentInfo(r);
  if (kept) {
    line = commandLine(kept); cwd = untildify(kept.cwd); why = `kept as "${kept.name}"`;
  } else if (agent) {
    line = resumeLine(r, agent);
    why = agent.sessionId ? `resumes ${agent.harness} session ${agent.sessionId.slice(0, 8)}` : "";
    if (!line) return { ok: false, reason: `this ${agent.harness} has no conversation yet — nothing to resume` };
  } else if (r.source === "typed" || r.source === "script") {
    line = r.command; why = r.source === "typed" ? "as you typed it" : "the package script that started it";
  } else if (r.source === "history") {
    line = r.command; exact = false; why = "guessed from shell history";
  } else if (r.kind === "term" && !r.leaderGone) {
    line = r.command; exact = r.command === r.argvCommand ? false : true; why = "rebuilt from its arguments";
  } else {
    return { ok: false, reason: "don't know the command that started it — keep it (space) with the right command first" };
  }
  if (!cwd) return { ok: false, reason: "don't know its directory" };

  const shellAlive = !!r.shellPid && isAlive(r.shellPid);
  if (shellAlive && r.term.tmux) return { ok: true, plan: { line, cwd, where: "tmux", whereLabel: `the same tmux pane (${r.term.tmux})`, exact, why } };
  if (shellAlive && r.term.orca) return { ok: true, plan: { line, cwd, where: "orca", whereLabel: "the same Orca terminal", exact, why } };
  if (Bun.which("tmux")) return { ok: true, plan: { line, cwd, where: "new-tmux", whereLabel: "a new tmux window", exact, why } };
  return { ok: true, plan: { line, cwd, where: "prompt", whereLabel: "your prompt", exact, why } };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const sh = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: (p.exitCode === 0 ? p.stdout : p.stderr).toString().trim() };
};

/** Is the shell back at its prompt (it owns the terminal's foreground)? */
function shellIdle(shellPid: number): boolean {
  const res = sh(["ps", "-o", "pgid=,tpgid=", "-p", String(shellPid)]);
  const [pgid, tpgid] = res.out.trim().split(/\s+/).map(Number);
  return res.ok && pgid === tpgid;
}

/**
 * Stop, wait, start. `onStatus` reports progress. Returns a final message, or
 * `prompt` when the caller should hand the line to the user's shell (TUI exits).
 */
export async function runRestart(
  r: Row,
  plan: RestartPlan,
  name: string,
  onStatus: (s: string) => void,
): Promise<{ ok: boolean; message: string; prompt?: { cwd: string; line: string } }> {
  onStatus("stopping…");
  killRow(r, "SIGTERM");
  const alive = () => r.pids.filter((p) => !(r.leaderGone && p === r.pgid) && isAlive(p));
  for (let i = 0; i < 50 && alive().length; i++) await sleep(100);
  if (alive().length) {
    onStatus("didn't stop in 5s — force-killing…");
    killRow(r, "SIGKILL");
    for (let i = 0; i < 20 && alive().length; i++) await sleep(100);
    if (alive().length) return { ok: false, message: `couldn't stop pid ${alive().join(", ")}` };
  }

  if (plan.where === "tmux" || plan.where === "orca") {
    // Wait for the shell to get its prompt back, then type into it.
    for (let i = 0; i < 30 && r.shellPid && !shellIdle(r.shellPid); i++) await sleep(100);
    const here = r.shellPid ? procCwd(r.shellPid) : null;
    const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
    const line = here && real(here) === real(plan.cwd) ? plan.line : `cd ${shellQuote(plan.cwd)} && ${plan.line}`;
    const res =
      plan.where === "tmux"
        ? (sh(["tmux", "send-keys", "-t", r.term.tmux!, "-l", line]).ok ? sh(["tmux", "send-keys", "-t", r.term.tmux!, "Enter"]) : { ok: false, out: "tmux send-keys failed" })
        : sh(["orca", "terminal", "send", "--terminal", r.term.orca!, "--text", line, "--enter"]);
    if (res.ok) return { ok: true, message: `restarted in ${plan.whereLabel}` };
    onStatus(`couldn't type into ${plan.whereLabel} — using a new tmux window`);
  }
  if (plan.where !== "prompt" && Bun.which("tmux")) {
    const res = toTmux({ name, command: plan.line, cwd: tildify(plan.cwd), kept: "" });
    return { ok: res.ok, message: res.ok ? `restarted — ${res.message}` : res.message };
  }
  return { ok: true, message: "", prompt: { cwd: plan.cwd, line: plan.line } };
}
