#!/usr/bin/env bun
// `running-core`: the same engine as the TUI, spoken over stdio for the desktop app.
//
// Protocol: one JSON object per line.
//   → {"id": 1, "method": "snapshot", "params": {…}}
//   ← {"id": 1, "result": …}        or   {"id": 1, "error": "message"}
//   ← {"event": "status", "id": 7, "text": "stopping…"}   progress of a running request
//   ← {"event": "changed"}                                  something worth a refresh (probe done)
//
// Everything a person can do in the TUI is a method here; the logic stays in the shared
// modules (procs, store, actions, restart, agents…) so the two front-ends can't drift apart.
import { basename } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { collect, gitBranch, isAlive, killPids, killRow, tildify, unkillableReason, base, type Member, type Row } from "./procs.ts";
import { loadSettings, saveSettings, SORTS, type SortKey } from "./settings.ts";
import { findKept, loadKept, matches, saveKept, sameEntry, KEPT_FILE, type Kept } from "./store.ts";
import { envChoices, prefixVars } from "./env.ts";
import { commandLine } from "./launch.ts";
import { focus, openUrl, outputFiles, peek, probe, type Probe } from "./actions.ts";
import { LOG_FILE, pruneLog } from "./hook.ts";
import { agentInfo, transcriptTail } from "./agents.ts";
import { planRestart, runRestart } from "./restart.ts";
import { startIn, TERMINALS, typedLine, type TerminalApp } from "./terminals.ts";
import pkg from "../package.json" with { type: "json" };

// stdout is the protocol: nothing else may write to it.
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
console.log = console.info = console.warn = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");

// ── environment ──────────────────────────────────────────────────────────
// An app started from Finder gets launchd's bare environment (PATH=/usr/bin:/bin:…). The
// desktop app asks your login shell for the environment a terminal would have and starts us
// with it (Bun reads PATH once at startup, so it can't be fixed from in here). It's also the
// baseline for "which variables are special to this process" when keeping one.
const ownEnv: Record<string, string | undefined> = process.env;

// ── state ────────────────────────────────────────────────────────────────
let rows: Row[] = [];
let kept: Kept[] = loadKept();
const probes = new Map<string, Probe | null | "pending">();
const probeKey = (pid: number, port: number) => `${pid}:${port}`;

const rowOf = (pid: number): Row => {
  const r = rows.find((x) => x.pid === pid);
  if (!r) throw new Error("that process is gone");
  return r;
};
const memberOf = (r: Row, pid?: number): Member | undefined => (pid ? r.members.find((m) => m.pid === pid) : undefined);

/** A member viewed as a stand-alone row, for peek/kill (as in the TUI). */
const childRow = (r: Row, m: Member): Row => ({
  ...r, pid: m.pid, pids: m.pids, members: [], leaderGone: false, tty: m.tty, cwd: m.cwd,
  command: m.argvCommand, argvCommand: m.argvCommand, displayArgv: m.displayArgv, listen: m.listen,
  ports: m.listen.map((l) => l.port), term: {},
});

function termLabel(r: Row): string {
  const t = r.term;
  if (t.tmux) return `tmux ${t.tmux}`;
  if (t.orca) return "Orca tab";
  if (t.app) return t.app.replace(/^Apple_/, "");
  return "";
}

function startProbes() {
  for (const l of rows.flatMap((r) => r.listen)) {
    const key = probeKey(l.pid, l.port);
    if (probes.has(key)) continue;
    probes.set(key, "pending");
    probe(l).then((res) => {
      probes.set(key, res);
      out({ event: "changed" });
    });
  }
}

const keptDTO = (k: Kept, index: number) => {
  const live = rows.find((r) => matches(k, r));
  return { index, name: k.name, command: k.command, cwd: k.cwd, env: k.env ?? {}, note: k.note ?? "", ports: k.ports ?? [], session: k.session, kept: k.kept, line: commandLine(k), livePid: live?.pid };
};

function rowDTO(r: Row) {
  const k = findKept(kept, r);
  const agent = agentInfo(r);
  return {
    pid: r.pid, pgid: r.pgid, kind: r.kind, command: r.command, argvCommand: r.argvCommand, displayArgv: r.displayArgv,
    source: r.source, leaderGone: r.leaderGone, exe: r.exe, cwd: r.cwd, listen: r.listen, where: r.where, tty: r.tty,
    stat: r.stat, etimeSec: r.etimeSec, rssKb: r.rssKb, cpu: r.cpu, pidCount: r.pids.length,
    members: r.members.map((m) => ({ pid: m.pid, ppid: m.ppid, depth: m.depth, displayArgv: m.displayArgv, argvCommand: m.argvCommand, cwd: m.cwd, listen: m.listen, tty: m.tty, stat: m.stat, etimeSec: m.etimeSec, rssKb: m.rssKb, cpu: m.cpu, pidCount: m.pids.length })),
    parentRow: r.parentRow, via: r.via, term: r.term, termLabel: termLabel(r), shellAlive: !!r.shellPid,
    keptIndex: k ? kept.indexOf(k) : undefined,
    agent: agent ?? undefined,
  };
}

// ── methods ──────────────────────────────────────────────────────────────
type Params = Record<string, any>;
type Ctx = { id: number; status: (text: string) => void };

const shellIntegration = () => {
  const zshrc = (() => { try { return readFileSync(`${homedir()}/.zshrc`, "utf8"); } catch { return ""; } })();
  let logAge: number | undefined;
  try { logAge = Date.now() / 1000 - statSync(LOG_FILE).mtimeMs / 1000; } catch {}
  return { zshrc: /running\s+init/.test(zshrc), logExists: existsSync(LOG_FILE), logAgeSec: logAge };
};

const terminalOf = (p: Params): TerminalApp => (p.terminal && p.terminal in TERMINALS ? p.terminal : "terminal");

const methods: Record<string, (p: Params, ctx: Ctx) => unknown | Promise<unknown>> = {
  hello: () => ({
    version: pkg.version, bun: Bun.version, pid: process.pid, keptFile: KEPT_FILE, logFile: LOG_FILE,
    shell: shellIntegration(), terminals: TERMINALS, sorts: Object.fromEntries(Object.entries(SORTS).map(([k, s]) => [k, { label: s.label, desc: s.desc, dirLabel: s.dirLabel }])),
  }),

  async snapshot() {
    rows = await collect({ selfPid: process.pid });
    kept = loadKept(); // pick up hand edits
    startProbes();
    const branches: Record<string, string | null> = {};
    for (const r of rows) if (r.cwd && r.cwd !== "/" && !(r.cwd in branches)) branches[r.cwd] = gitBranch(r.cwd);
    return {
      at: Date.now() / 1000,
      rows: rows.map(rowDTO),
      kept: kept.map(keptDTO),
      probes: [...probes].map(([key, v]) => {
        const [pid, port] = key.split(":").map(Number);
        return v === "pending" ? { pid, port, pending: true } : { pid, port, pending: false, web: !!v?.web, url: v?.url, title: v?.title, status: v?.status };
      }),
      branches,
      sort: loadSettings().sort,
    };
  },

  setSort: (p) => {
    const key = p.key as SortKey;
    if (!(key in SORTS)) throw new Error(`unknown sort ${p.key}`);
    saveSettings({ ...loadSettings(), sort: { key, desc: !!p.desc } });
    return loadSettings().sort;
  },

  kill: (p) => {
    const r = rowOf(p.pid);
    const m = memberOf(r, p.child);
    const sig = p.force ? "SIGKILL" : "SIGTERM";
    const n = m ? killPids(m.pids, sig) : killRow(r, sig);
    return { sent: n, signal: sig };
  },

  /** Why something survived kill -9 (zombie, D-wait), as the TUI explains it. */
  whyAlive: (p) => {
    const r = rows.find((x) => x.pid === p.pid);
    const m = r && memberOf(r, p.child);
    const target = m ? m.pid : r?.leaderGone ? r.pids.find((x) => x !== r.pgid && isAlive(x)) ?? r.pid : p.pid;
    const why = unkillableReason(target);
    return { pid: target, alive: isAlive(target), reason: why ?? `pid ${target} is still there — it may be restarted by its parent or by launchd` };
  },

  openUrl: (p) => { openUrl(String(p.url)); return { ok: true }; },

  focus: (p) => {
    const res = focus(rowOf(p.pid));
    if (res.prompt) {
      // tmux outside tmux: open a terminal attached to that pane.
      const t = terminalOf(p) === "tmux" ? "terminal" : terminalOf(p);
      const s = startIn(t, "", res.prompt);
      return { ok: s.ok, message: s.ok ? `${res.message} — attached in a new ${TERMINALS[t].label} window` : s.message };
    }
    return res;
  },

  peek: (p) => {
    const r = rowOf(p.pid);
    const lines = Math.max(50, Math.min(2000, Number(p.lines) || 400));
    const m = memberOf(r, p.child);
    const src: string | undefined = p.source || undefined;
    if (m) {
      const cr = childRow(r, m);
      const files = outputFiles(cr);
      const data = files.length ? peek(cr, lines, src ?? files[0]) : peek(r, lines, src);
      return { ...data, source: src ?? (files.length ? files[0] : undefined), kind: "output" };
    }
    const a = agentInfo(r);
    if (src === "@transcript" && a) {
      const data = peek(r, 1, undefined);
      return { title: `${a.harness} conversation — ${tildify(a.transcript ?? "")}`, lines: transcriptTail(a, lines), sources: [...(a.transcript ? ["@transcript"] : []), ...data.sources], source: src, kind: "conversation" };
    }
    const data = peek(r, lines, src);
    return { ...data, sources: [...(a?.transcript ? ["@transcript"] : []), ...data.sources], source: src, kind: "output" };
  },

  planRestart: (p) => {
    const r = rowOf(p.pid);
    return planRestart(r, findKept(kept, r));
  },

  async restart(p, ctx) {
    const r = rowOf(p.pid);
    const k = findKept(kept, r);
    const res = planRestart(r, k);
    if (!res.ok) return { ok: false, message: res.reason };
    const plan = res.plan;
    const name = k?.name ?? agentInfo(r)?.harness ?? base(plan.line.split(/\s+/)[0] ?? "restart");
    const done = await runRestart(r, plan, name, ctx.status);
    if (done.prompt) {
      const s = startIn(terminalOf(p), done.prompt.cwd, done.prompt.line, name);
      return { ok: s.ok, message: s.ok ? `restarted — ${s.message}` : s.message };
    }
    return { ok: done.ok, message: done.message };
  },

  /** Defaults for the "keep" form, as the TUI computes them. */
  keepDraft: (p) => {
    const r = rowOf(p.pid);
    const already = findKept(kept, r);
    const agent = agentInfo(r);
    const words = r.command.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const prog = base(words[0] ?? "");
    const sub = /^(npm|pnpm|yarn|bun|just|make)$/.test(prog) ? words.filter((a) => a !== "run")[1] : undefined;
    return {
      alreadyKept: already ? { index: kept.indexOf(already), name: already.name } : undefined,
      title: r.leaderGone
        ? `Keep "${r.command}" — the command that started ${r.pids.length === 1 ? "this process" : `these ${r.pids.length} processes`}`
        : "Keep this process",
      name: agent?.title ? `${agent.harness}: ${agent.title.slice(0, 40)}` : `${basename(r.cwd) || prog} ${sub ?? prog}`.trim(),
      command: agent?.resume ?? r.command,
      cwd: tildify(r.cwd),
      note: "",
      env: envChoices(r.env, r.baseEnv, ownEnv, prefixVars(r.command)),
    };
  },

  keep: (p) => {
    const r = rowOf(p.pid);
    const v = clean(p.values);
    kept = loadKept();
    const dup = kept.find((x) => sameEntry(x, { command: v.command, cwd: v.cwd }));
    if (dup) return { ok: false, message: `already kept as "${dup.name}"` };
    const agent = agentInfo(r);
    const session = agent?.sessionId && v.command.includes(agent.sessionId) ? agent.sessionId : undefined;
    const prog = base(v.command.split(/\s+/)[0] ?? "");
    kept = [...kept, { name: v.name || prog, command: v.command, cwd: v.cwd, env: v.env, note: v.note, ports: r.ports, session, kept: new Date().toISOString() }];
    saveKept(kept);
    return { ok: true, message: `kept "${v.name || prog}"`, index: kept.length - 1 };
  },

  edit: (p) => {
    kept = loadKept();
    const i = Number(p.index);
    if (!kept[i]) throw new Error("that kept entry is gone");
    const v = clean(p.values);
    kept = kept.map((x, j) => (j === i ? { ...x, name: v.name, command: v.command, cwd: v.cwd, note: v.note, env: v.env } : x));
    saveKept(kept);
    return { ok: true, message: `saved "${v.name}"` };
  },

  forget: (p) => {
    kept = loadKept();
    const k = kept[Number(p.index)];
    if (!k) throw new Error("that kept entry is gone");
    kept = kept.filter((_, j) => j !== Number(p.index));
    saveKept(kept);
    return { ok: true, message: `forgot "${k.name}"`, restore: k };
  },

  /** Undo a forget: put the entry back where it was. */
  restoreKept: (p) => {
    kept = loadKept();
    const k = p.kept as Kept;
    if (!k?.command || !k?.cwd) throw new Error("nothing to restore");
    if (kept.some((x) => sameEntry(x, k))) return { ok: true, message: `"${k.name}" is already kept` };
    const at = Math.max(0, Math.min(kept.length, Number(p.index) || 0));
    kept = [...kept.slice(0, at), k, ...kept.slice(at)];
    saveKept(kept);
    return { ok: true, message: `"${k.name}" is back` };
  },

  move: (p) => {
    kept = loadKept();
    const from = Number(p.from), to = Number(p.to);
    if (!kept[from]) throw new Error("that kept entry is gone");
    const list = [...kept];
    const [k] = list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, to)), 0, k!);
    kept = list;
    saveKept(kept);
    return { ok: true };
  },

  start: (p) => {
    kept = loadKept();
    const k = kept[Number(p.index)];
    if (!k) throw new Error("that kept entry is gone");
    const res = startIn(terminalOf(p), k.cwd, commandLine(k), k.name);
    return res;
  },

  /** `cd dir && command` for the clipboard, quoted like the TUI's `c`. */
  copyLine: (p) => ({ line: typedLine(String(p.cwd ?? ""), String(p.command ?? "")) }),
};

function clean(v: any) {
  const s = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  const env: Record<string, string> = {};
  for (const e of Array.isArray(v?.env) ? v.env : []) if (e?.selected && e.key) env[String(e.key)] = String(e.value ?? "");
  const out = { name: s(v?.name), command: s(v?.command), cwd: s(v?.cwd), note: s(v?.note), env };
  if (!out.command) throw new Error("the command can't be empty");
  if (!out.cwd) throw new Error("the directory can't be empty");
  return out;
}

// ── loop ─────────────────────────────────────────────────────────────────
pruneLog();
let buf = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req: { id: number; method: string; params?: Params };
    try { req = JSON.parse(line); } catch { out({ id: 0, error: "bad JSON" }); continue; }
    const fn = methods[req.method];
    const ctx: Ctx = { id: req.id, status: (text) => out({ event: "status", id: req.id, text }) };
    if (!fn) { out({ id: req.id, error: `unknown method ${req.method}` }); continue; }
    Promise.resolve()
      .then(() => fn(req.params ?? {}, ctx))
      .then((result) => out({ id: req.id, result: result ?? null }), (e) => out({ id: req.id, error: (e as Error)?.message ?? String(e) }));
  }
}
process.exit(0);
