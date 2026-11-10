// Kept processes live in a hand-editable YAML file.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { parse, stringify } from "yaml";
import { untildify, tildify, type Row } from "./procs.ts";
import { agentInfo } from "./agents.ts";
import { sameCommand, sameDir, sessionIds } from "./fingerprint.ts";

export interface Kept {
  name: string;
  command: string; // exactly what gets typed at the prompt
  cwd: string; // stored with ~ for readability
  env?: Record<string, string>;
  note?: string;
  ports?: number[]; // informational: what it listened on when kept
  session?: string; // AI agent conversation id: matches the process in that session wherever it runs
  kept: string; // ISO timestamp
}

const DIR = process.env.RUNNING_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "running");
export const KEPT_FILE = join(DIR, "kept.yaml");

const HEADER = `# Processes kept by \`running\`. Safe to edit by hand.
# command: what gets typed at the prompt; cwd: where it's run from;
# env: variables prefixed to the command when it's started.
`;

export function loadKept(): Kept[] {
  if (!existsSync(KEPT_FILE)) return [];
  const doc = parse(readFileSync(KEPT_FILE, "utf8")) as { processes?: Kept[] } | null;
  const list = (doc?.processes ?? []).filter((k) => k && k.command && k.cwd);
  // Drop duplicates (older versions could keep the same process twice); first one wins.
  const unique = list.filter((k, i) => !list.slice(0, i).some((x) => sameEntry(x, k)));
  if (unique.length < list.length) saveKept(unique);
  return unique;
}

export function saveKept(list: Kept[]): void {
  mkdirSync(DIR, { recursive: true });
  const clean = list.map((k) => {
    const o: Partial<Kept> = { name: k.name, command: k.command, cwd: tildify(untildify(k.cwd)) };
    if (k.env && Object.keys(k.env).length) o.env = k.env;
    if (k.note) o.note = k.note;
    if (k.ports?.length) o.ports = k.ports;
    if (k.session) o.session = k.session;
    o.kept = k.kept;
    return o as Kept;
  });
  const tmp = KEPT_FILE + ".tmp";
  writeFileSync(tmp, HEADER + stringify({ processes: clean }, { lineWidth: 0 }));
  renameSync(tmp, KEPT_FILE); // atomic: a crash never leaves a half-written file
}

/**
 * Does this running row correspond to a kept entry?
 *  1. An agent in the kept conversation (session id) — regardless of how it was launched.
 *  2. Otherwise same directory and the same command, compared parsed (see fingerprint.ts):
 *     launcher-added options, `bun dev`/`bun run dev`, full paths and env prefixes don't matter.
 */
export function matches(k: Kept, r: Row): boolean {
  const agent = agentInfo(r);
  if (agent?.sessionId) {
    const ids = k.session ? new Set([k.session.toLowerCase()]) : sessionIds(k.command);
    if (ids.has(agent.sessionId.toLowerCase())) return true;
  }
  if (!sameDir(untildify(k.cwd), r.cwd)) return false;
  return sameCommand(k.command, r.command) || sameCommand(k.command, r.argv) || sameCommand(k.command, r.displayArgv);
}

export function findKept(list: Kept[], r: Row): Kept | undefined {
  return list.find((k) => matches(k, r));
}

/** Same command in the same directory (what makes a second keep a duplicate). */
export const sameEntry = (a: Pick<Kept, "command" | "cwd">, b: Pick<Kept, "command" | "cwd">) =>
  sameDir(untildify(a.cwd), untildify(b.cwd)) && sameCommand(a.command, b.command) && sameCommand(b.command, a.command);
