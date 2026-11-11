// Does a kept entry describe this running process? Exact string comparison is
// too brittle: launchers add flags (Orca runs `codex --no-daemon -c … resume <id>`
// for a kept `codex resume <id>`), package runners have two spellings
// (`bun dev` / `bun run dev`), shells resolve paths (`/tmp` vs `/private/tmp`).
// We compare parsed commands instead, and agent sessions by their id.
import { basename } from "node:path";
import { realpathSync } from "node:fs";

/** Split a command line like a shell would (quotes, backslashes); no expansion. */
export function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = "", has = false, q: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === "\\" && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1]!)) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ""; has = false; continue; }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

export interface Parsed {
  env: Record<string, string>;
  prog: string; // basename of the program
  args: string[];
}

const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);

export function parseCommand(cmd: string | string[]): Parsed {
  const words = Array.isArray(cmd) ? cmd : shellWords(cmd);
  const env: Record<string, string> = {};
  let i = 0;
  for (; i < words.length; i++) {
    const m = words[i]!.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (!m) break;
    env[m[1]!] = m[2]!;
  }
  const prog = basename(words[i] ?? "");
  let args = words.slice(i + 1);
  // `bun run dev` ≡ `bun dev`, `npm run dev` ≡ `npm dev` for comparison purposes.
  if (RUNNERS.has(prog) && args[0] === "run") args = args.slice(1);
  return { env, prog, args };
}

const isOption = (a: string) => a.startsWith("-") && a.length > 1;

/**
 * `kept` args appear in `running` args in order, and everything else in `running`
 * is an option (or an option's value). So `codex resume X` matches
 * `codex --no-daemon -c k=v resume X`, but not `codex resume Y` or `codex exec …`.
 */
export function argsCover(running: string[], kept: string[]): boolean {
  let k = 0;
  for (let i = 0; i < running.length; i++) {
    const a = running[i]!;
    if (k < kept.length && a === kept[k]) { k++; continue; }
    if (isOption(a)) {
      // `-c value` / `--flag value`: also skip the value (but not `--flag=value`).
      const next = running[i + 1];
      if (!a.includes("=") && next !== undefined && !isOption(next) && next !== kept[k]) i++;
      continue;
    }
    return false; // an extra positional argument changes what the command does
  }
  return k === kept.length;
}

export function sameCommand(kept: string, running: string | string[]): boolean {
  const a = parseCommand(kept);
  const b = parseCommand(running);
  if (!a.prog || a.prog !== b.prog) return false;
  // Variables the kept command sets must have the same value if the running one shows them.
  for (const [k, v] of Object.entries(a.env)) if (k in b.env && b.env[k] !== v) return false;
  return argsCover(b.args, a.args);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Session ids mentioned in a command (`codex resume <id>`, `claude --resume <id>`, `pi --session <id>`). */
export const sessionIds = (cmd: string) => new Set((cmd.match(UUID) ?? []).map((s) => s.toLowerCase()));

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/**
 * Other apps' sandbox containers. Touching them (realpath, stat) can block until macOS's
 * "access data from other apps" protection answers — it hung the app on Tailscale's
 * network extension. Nothing you'd keep runs there, so never look inside.
 */
export const isAppContainer = (p: string) => /\/Library\/(Group )?Containers\//.test(p);

export const sameDir = (a: string, b: string) =>
  !!a && !!b && (a === b || (!isAppContainer(a) && !isAppContainer(b) && real(a) === real(b)));
