// Knowledge about AI coding-agent harnesses: which session a running process
// is in, what it's about, how busy it is, and how to resume it. Everything here
// is read from the harnesses' own local files — nothing is sent anywhere.
//
//   codex   ~/.codex/state_5.sqlite (threads) + rollout-*.jsonl transcripts
//   claude  ~/.claude/sessions/<pid>.json (live status) + ~/.claude/projects/<cwd>/<id>.jsonl
//   pi      ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { procStart } from "./native.ts";
import { base, type Row } from "./procs.ts";
import { isCodexAppServer } from "./codex-server.ts";

export type Harness = "codex" | "claude" | "pi";

export interface AgentInfo {
  harness: Harness;
  sessionId?: string;
  title?: string;
  model?: string;
  tokens?: number;
  costUsd?: number;
  lastActive?: number; // epoch seconds
  status?: "working" | "idle" | "new"; // new = no conversation yet
  branch?: string;
  transcript?: string; // session file
  resume?: string; // command that reopens this exact conversation
}

const HOME = homedir();

export function harnessOf(r: Row): Harness | null {
  const prog = base(r.displayArgv[0] ?? "");
  if (prog === "codex" || prog === "claude" || prog === "pi") return prog;
  const exe = basename(r.exe);
  return exe === "codex" || exe === "claude" ? exe : null;
}

// ── small helpers ────────────────────────────────────────────────────────

const mtime = (f: string) => { try { return statSync(f).mtimeMs / 1000; } catch { return undefined; } };
/** "working" if the transcript was written in the last 20 seconds. */
const liveness = (f?: string): AgentInfo["status"] => {
  const m = f ? mtime(f) : undefined;
  return m && Date.now() / 1000 - m < 20 ? "working" : "idle";
};
const firstLine = (s?: string | null) => s?.split("\n").find((l) => l.trim())?.trim().slice(0, 120);

/** Incrementally parse an append-only JSONL file; `fold` sees only new lines. */
interface Tail<A> { size: number; acc: A }
const tails = new Map<string, Tail<any>>();
function foldJsonl<A>(file: string, init: () => A, fold: (acc: A, line: any) => void): A {
  let st;
  try { st = statSync(file); } catch { return init(); }
  let t = tails.get(file) as Tail<A> | undefined;
  if (!t || st.size < t.size) t = { size: 0, acc: init() };
  if (st.size > t.size) {
    // Huge files (codex rollouts reach 50 MB): only the last 2 MB on first read.
    const fresh = t.size === 0;
    const start = fresh ? Math.max(0, st.size - (2 << 20)) : t.size;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    const skip = fresh && start > 0 ? buf.indexOf(10) + 1 : 0; // drop the partial first line
    const end = buf.lastIndexOf(10) + 1; // only complete lines; the rest is read next time
    if (end > skip) {
      for (const line of buf.subarray(skip, end).toString("utf8").split("\n")) {
        if (!line) continue;
        try { fold(t.acc, JSON.parse(line)); } catch {}
      }
    }
    t.size = start + Math.max(end, skip);
  }
  tails.set(file, t);
  return t.acc;
}

// ── codex ────────────────────────────────────────────────────────────────

let codexDb: Database | null | undefined;
function codexThreads(): Database | null {
  if (codexDb !== undefined) return codexDb;
  const f = join(HOME, ".codex", "state_5.sqlite");
  try { codexDb = existsSync(f) ? new Database(f, { readonly: true }) : null; } catch { codexDb = null; }
  return codexDb;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function codex(r: Row, started: number): AgentInfo {
  const info: AgentInfo = { harness: "codex" };
  // An app-server can host many conversations; its cwd/start time identifies
  // neither a specific thread nor that thread's activity or resume command.
  if (isCodexAppServer(r.argv)) return info;
  const i = r.argv.indexOf("resume");
  const fromArgv = i >= 0 && UUID.test(r.argv[i + 1] ?? "") ? r.argv[i + 1] : undefined;
  const db = codexThreads();
  type T = { id: string; name: string | null; title: string | null; model: string | null; tokens_used: number | null; updated_at_ms: number | null; git_branch: string | null; rollout_path: string | null };
  let t: T | null = null;
  try {
    t = fromArgv
      ? (db?.query("select id,name,title,model,tokens_used,updated_at_ms,git_branch,rollout_path from threads where id = ?").get(fromArgv) as T | null)
      : (db?.query("select id,name,title,model,tokens_used,updated_at_ms,git_branch,rollout_path from threads where cwd = ? and created_at_ms >= ? order by created_at_ms desc limit 1").get(r.cwd, (started - 5) * 1000) as T | null);
  } catch {}
  info.sessionId = t?.id ?? fromArgv;
  if (!t) return { ...info, status: info.sessionId ? "idle" : "new", resume: info.sessionId ? `codex resume ${info.sessionId}` : undefined };
  info.title = firstLine(t.name) ?? firstLine(t.title);
  info.model = t.model ?? undefined;
  info.tokens = t.tokens_used ?? undefined;
  info.branch = t.git_branch ?? undefined;
  info.transcript = t.rollout_path ?? undefined;
  info.lastActive = Math.max((t.updated_at_ms ?? 0) / 1000, mtime(info.transcript ?? "") ?? 0) || undefined;
  info.status = liveness(info.transcript);
  info.resume = `codex resume ${t.id}`;
  return info;
}

// ── claude ───────────────────────────────────────────────────────────────

const claudeProjectDir = (cwd: string) => join(HOME, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

function claude(r: Row): AgentInfo {
  const info: AgentInfo = { harness: "claude" };
  let s: any;
  try { s = JSON.parse(readFileSync(join(HOME, ".claude", "sessions", `${r.pid}.json`), "utf8")); } catch {}
  if (!s?.sessionId) return { ...info, status: "new" };
  info.sessionId = s.sessionId;
  info.title = s.name;
  info.status = s.status === "busy" ? "working" : "idle";
  info.lastActive = (s.statusUpdatedAt ?? s.updatedAt) / 1000 || undefined;
  info.resume = `claude --resume ${s.sessionId}`;
  const f = join(claudeProjectDir(s.cwd ?? r.cwd), `${s.sessionId}.jsonl`);
  if (existsSync(f)) {
    info.transcript = f;
    const acc = foldJsonl(f, () => ({ model: "", tokens: 0, title: "", last: 0 }), (a, d) => {
      if (d.type === "assistant" && d.message) {
        a.model = d.message.model ?? a.model;
        const u = d.message.usage ?? {};
        a.tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
      if (d.type === "custom-title" && d.customTitle) a.title = d.customTitle;
      if (d.timestamp) a.last = Date.parse(d.timestamp) / 1000 || a.last;
    });
    info.model = acc.model || undefined;
    info.tokens = acc.tokens || undefined;
    info.title = acc.title || info.title;
    info.lastActive = Math.max(info.lastActive ?? 0, acc.last) || undefined;
  } else {
    info.status = "new";
  }
  const mi = r.argv.indexOf("--model");
  info.model ??= mi >= 0 ? r.argv[mi + 1] : undefined;
  return info;
}

// ── pi ───────────────────────────────────────────────────────────────────

const piSessionDir = (cwd: string) => join(HOME, ".pi", "agent", "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);

function pi(r: Row, started: number): AgentInfo {
  const info: AgentInfo = { harness: "pi" };
  const dir = piSessionDir(r.cwd);
  let file: string | undefined;
  // An explicit --session wins; otherwise the newest session created after the process started.
  const si = r.argv.findIndex((a) => a === "--session" || a === "--session-id");
  const want = si >= 0 ? r.argv[si + 1] : undefined;
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    file = want
      ? files.find((f) => f.includes(want))
      : files.find((f) => {
          const ts = Date.parse(f.slice(0, 24).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, "T$1:$2:$3.$4Z"));
          return ts / 1000 >= started - 5;
        });
  } catch {}
  if (!file) return { ...info, status: "new" };
  const path = join(dir, file);
  info.transcript = path;
  const acc = foldJsonl(path, () => ({ id: "", model: "", tokens: 0, cost: 0, first: "", name: "", last: 0 }), (a, d) => {
    if (d.type === "session") a.id = d.id;
    if (d.type === "model_change") a.model = d.modelId ?? a.model;
    if (d.type === "session_info" && d.name) a.name = d.name;
    const m = d.message;
    if (m?.role === "user" && !a.first) {
      const c = typeof m.content === "string" ? m.content : m.content?.find?.((x: any) => x.type === "text")?.text;
      if (c) a.first = c;
    }
    if (m?.role === "assistant") {
      a.model = m.model ?? a.model;
      a.tokens += m.usage?.totalTokens ?? 0;
      a.cost += m.usage?.cost?.total ?? 0;
    }
    if (d.timestamp) a.last = Date.parse(d.timestamp) / 1000 || a.last;
  });
  info.sessionId = acc.id || undefined;
  info.title = firstLine(acc.name) ?? firstLine(acc.first);
  info.model = acc.model || undefined;
  info.tokens = acc.tokens || undefined;
  info.costUsd = acc.cost || undefined;
  info.lastActive = acc.last || mtime(path);
  info.status = liveness(path);
  info.resume = acc.id ? `pi --session ${acc.id}` : undefined;
  return info;
}

// ── entry ────────────────────────────────────────────────────────────────

const cache = new Map<number, { at: number; info: AgentInfo }>();

/** Agent details for a row, or null if it isn't a known harness. Cached for 3s per process. */
export function agentInfo(r: Row): AgentInfo | null {
  const h = harnessOf(r);
  if (!h || r.leaderGone) return null;
  const hit = cache.get(r.pid);
  if (hit && Date.now() - hit.at < 3000) return hit.info;
  const started = procStart(r.pid) ?? Date.now() / 1000 - r.etimeSec;
  const info = h === "codex" ? codex(r, started) : h === "claude" ? claude(r) : pi(r, started);
  cache.set(r.pid, { at: Date.now(), info });
  return info;
}

/**
 * The command that brings this agent back in the same conversation. For codex,
 * if the original argv already resumes this session, reuse it verbatim — it may
 * carry host-specific -c flags (Orca sets several).
 */
export function resumeLine(r: Row, a: AgentInfo): string | undefined {
  if (a.harness === "codex" && a.sessionId && r.argv.includes(a.sessionId)) return r.argvCommand;
  return a.resume;
}

// ── transcript peek ──────────────────────────────────────────────────────

/** Recent conversation as plain lines: `› you: …` / `‹ codex: …` / tool calls. */
export function transcriptTail(a: AgentInfo, maxLines: number): string[] {
  if (!a.transcript) return ["(no conversation yet)"];
  let text = "";
  try {
    const fd = openSync(a.transcript, "r");
    const size = statSync(a.transcript).size;
    const len = Math.min(size, 768 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    text = buf.toString("utf8");
    if (len < size) text = text.slice(text.indexOf("\n") + 1);
  } catch { return ["(transcript unreadable)"]; }

  const out: string[] = [];
  const say = (who: string, s: string) => {
    const lines = s.replace(/\r/g, "").split("\n").filter((l) => l.trim());
    if (!lines.length) return;
    out.push("");
    out.push(`${who} ${lines[0]}`);
    for (const l of lines.slice(1, 12)) out.push(`  ${l}`);
    if (lines.length > 12) out.push(`  … (${lines.length - 12} more lines)`);
  };
  const textOf = (c: any): string =>
    typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x?.type === "text" || x?.type === "input_text" || x?.type === "output_text" ? x.text : "")).join("\n") : "";
  const me = a.harness;

  for (const line of text.split("\n")) {
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (me === "codex") {
      const p = d.payload ?? {};
      if (d.type === "response_item" && p.type === "message" && (p.role === "user" || p.role === "assistant")) {
        const t = textOf(p.content);
        if (p.role === "user" && (t.startsWith("<") || t.startsWith("# AGENTS.md"))) continue; // injected context
        say(p.role === "user" ? "› you:" : `‹ ${me}:`, t);
      } else if (d.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
        out.push(`  ⚙ ${p.name}${p.input ? " " + String(p.input).split("\n")[0]!.slice(0, 100) : ""}`);
      }
    } else if (me === "claude") {
      const m = d.message;
      if (d.type === "user" && typeof m?.content === "string" && !m.content.startsWith("<")) say("› you:", m.content);
      if (d.type === "assistant" && Array.isArray(m?.content)) {
        for (const part of m.content) {
          if (part.type === "text") say(`‹ ${me}:`, part.text);
          if (part.type === "tool_use") out.push(`  ⚙ ${part.name} ${JSON.stringify(part.input ?? {}).slice(0, 100)}`);
        }
      }
    } else {
      const m = d.message;
      if (m?.role === "user") say("› you:", textOf(m.content));
      if (m?.role === "assistant") {
        say(`‹ ${me}:`, textOf(m.content));
        for (const part of Array.isArray(m.content) ? m.content : [])
          if (part.type === "toolCall") out.push(`  ⚙ ${part.name} ${JSON.stringify(part.arguments ?? {}).slice(0, 100)}`);
      }
    }
  }
  return out.slice(-maxLines);
}

export const fmtTokens = (n?: number) =>
  n === undefined ? "" : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

