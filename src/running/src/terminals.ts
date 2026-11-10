// Starting a command in a new terminal tab/window — used by the desktop app, which has no
// prompt of its own to hand a command to. The command is *typed* into a fresh interactive
// shell (not run with -c), so it lands in that shell's history and the command log, exactly
// as if you had typed it — `running` can then name it and find its terminal later.
import { shellQuote, tildify, untildify } from "./procs.ts";
import { toTmux } from "./launch.ts";

export type TerminalApp = "terminal" | "iterm" | "ghostty" | "tmux";

export const TERMINALS: Record<TerminalApp, { label: string; app?: string }> = {
  terminal: { label: "Terminal", app: "Terminal" },
  iterm: { label: "iTerm2", app: "iTerm" },
  ghostty: { label: "Ghostty", app: "Ghostty" },
  tmux: { label: "tmux (new window)" },
};

const sh = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: (p.exitCode === 0 ? p.stdout : p.stderr).toString().trim() };
};

/** An AppleScript string literal. */
export const asString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const pathArg = (p: string) => (/^[\w./~+-]+$/.test(tildify(p)) ? tildify(p) : shellQuote(p));

/** `cd dir && line` — what gets typed. */
export const typedLine = (dir: string, line: string) => (dir ? `cd ${pathArg(dir)} && ${line}` : line);

/**
 * Open a new tab/window in `terminal` and type `line` (after cd'ing to `dir`) + Enter.
 * `name` titles the tmux window.
 */
export function startIn(terminal: TerminalApp, dir: string, line: string, name = "running"): { ok: boolean; message: string } {
  const cwd = untildify(dir);
  const full = typedLine(cwd, line);
  const label = TERMINALS[terminal]?.label ?? terminal;
  let res: { ok: boolean; out: string };
  switch (terminal) {
    case "tmux":
      return toTmux({ name, command: line, cwd: tildify(cwd), kept: "" });
    case "terminal":
      res = sh(["osascript", "-e", `tell application "Terminal"
        activate
        do script ${asString(full)}
      end tell`]);
      break;
    case "iterm":
      res = sh(["osascript", "-e", `tell application "iTerm"
        activate
        set w to (create window with default profile)
        tell current session of w to write text ${asString(full)}
      end tell`]);
      break;
    case "ghostty":
      res = sh(["osascript", "-e", `tell application "Ghostty"
        activate
        set cfg to new surface configuration
        set initial working directory of cfg to ${asString(cwd)}
        set initial input of cfg to ${asString(line + "\n")}
        new window with configuration cfg
      end tell`]);
      break;
    default:
      return { ok: false, message: `unknown terminal "${terminal}"` };
  }
  if (res.ok) return { ok: true, message: `started in a new ${label} window` };
  const denied = /not allowed|-1743|not authori[sz]ed/i.test(res.out);
  return {
    ok: false,
    message: denied
      ? `macOS didn't let Running control ${label} — allow it in System Settings › Privacy & Security › Automation`
      : `couldn't start it in ${label}: ${res.out.split("\n")[0]}`,
  };
}
