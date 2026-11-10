import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basename, relative } from "node:path";
import { collect, gitBranch, isAlive, killPids, killRow, tildify, untildify, unkillableReason, base, type Listen, type Member, type Row } from "../procs.ts";
import { loadSettings, saveSettings, SORTS, type SortKey } from "../settings.ts";
import { findKept, loadKept, matches, saveKept, sameEntry, type Kept } from "../store.ts";
import { envChoices, prefixVars } from "../env.ts";
import { commandLine, HANDOFF, handOff, toTmux } from "../launch.ts";
import { focus, openUrl, outputFiles, peek, probe, type Peek, type Probe } from "../actions.ts";
import { pruneLog } from "../hook.ts";
import { agentInfo, fmtTokens, transcriptTail, type AgentInfo } from "../agents.ts";
import { planRestart, runRestart } from "../restart.ts";
import pkg from "../../package.json" with { type: "json" };
import { Form, type FormValues } from "./Form.tsx";
import { ago, c, fit, fmtMem, fmtUptime } from "./theme.ts";

type Mode = "procs" | "kept";
type Item =
  | { type: "header"; label: string; tag?: string; count: number; muted: boolean }
  | { type: "dir"; dir: string; branch: string | null; count: number; muted: boolean }
  | { type: "row"; row: Row; depth: number }
  | { type: "child"; row: Row; m: Member; prefix: string }
  | { type: "kept"; kept: Kept; index: number; live?: Row };

type Confirm = { text: string; onYes: () => void };
type Overlay =
  | { type: "keep"; row: Row }
  | { type: "edit"; index: number }
  | { type: "peek"; pid: number; child?: number; source?: string }
  | { type: "help" };

export interface ExitAction {
  print?: string; // shown after the TUI closes (fallback when not run via the shell function)
  copied?: boolean;
}

const KIND_RANK = { term: 0, server: 1, daemon: 2, app: 3 } as const;
const REFRESH_MS = 2000;
const STUCK_AFTER_MS = 3000;
const DETAILS_H = 7;
const TRANSCRIPT = "@transcript";

// Probes are per socket: the process that owns the port + the port.
type Probes = Map<string, Probe | null | "pending">;
const probeKey = (l: Listen) => `${l.pid}:${l.port}`;
const isWeb = (l: Listen, probes: Probes) => {
  const p = probes.get(probeKey(l));
  return !!p && p !== "pending" && p.web;
};
function webPages(listen: Listen[], probes: Probes): Probe[] {
  return listen.map((l) => probes.get(probeKey(l))).filter((p): p is Probe => !!p && p !== "pending" && p.web);
}

/** A member viewed as a stand-alone row, for peek/kill. */
const childRow = (r: Row, m: Member): Row => ({
  ...r, pid: m.pid, pids: m.pids, members: [], leaderGone: false, tty: m.tty, cwd: m.cwd,
  command: m.argvCommand, argvCommand: m.argvCommand, displayArgv: m.displayArgv, listen: m.listen,
  ports: m.listen.map((l) => l.port), term: {},
});

export function App(props: { onExit: (a: ExitAction) => void }) {
  const { exit } = useApp();
  // Terminal size; re-renders on resize.
  const { columns, rows: termRows } = useWindowSize();
  const size = { w: columns, h: termRows };

  const [mode, setMode] = useState<Mode>("procs");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [kept, setKept] = useState<Kept[]>(() => loadKept());
  const [probes, setProbes] = useState<Probes>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>(() => loadSettings().sort);
  useEffect(() => saveSettings({ sort }), [sort]);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [sortMenu, setSortMenu] = useState(false); // `s` pressed: the next key picks the sort
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [peekData, setPeekData] = useState<Peek | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "warn" | "err" } | null>(null);
  const [stopping, setStopping] = useState<Map<number, { at: number; force: boolean }>>(new Map());
  const [sel, setSel] = useState<{ procs: number | null; kept: number }>({ procs: null, kept: 0 });
  const lastPos = useRef({ procs: 0, kept: 0 });
  const [top, setTop] = useState(0);

  // ── data ───────────────────────────────────────────────────────────────
  useEffect(() => pruneLog(), []);
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await collect({ selfPid: process.pid });
      setRows(next);
      setKept(loadKept()); // pick up hand edits to kept.yaml
      const alive = new Set(next.flatMap((r) => [r.pid, ...r.members.map((m) => m.pid)]));
      setStopping((s) => {
        const n = new Map(s);
        for (const pid of n.keys()) if (!alive.has(pid)) n.delete(pid);
        return n;
      });
    } catch (e) {
      setStatus({ text: `refresh failed: ${(e as Error).message}`, tone: "err" });
    } finally {
      busy.current = false;
    }
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Probe each new listening socket once: is it a web page?
  useEffect(() => {
    if (!rows) return;
    const todo = rows.flatMap((r) => r.listen).filter((l) => !probes.has(probeKey(l)));
    if (!todo.length) return;
    setProbes((m) => {
      const n = new Map(m);
      for (const l of todo) n.set(probeKey(l), "pending");
      return n;
    });
    for (const l of todo) probe(l).then((res) => setProbes((m) => new Map(m).set(probeKey(l), res)));
  }, [rows]);

  const flash = (text: string, tone: "ok" | "warn" | "err" = "ok") => setStatus({ text, tone });
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 5000);
    return () => clearTimeout(t);
  }, [status]);

  const persist = (list: Kept[]) => {
    saveKept(list);
    setKept(list);
  };

  // ── derived lists ──────────────────────────────────────────────────────
  const q = filter.toLowerCase();
  const keptOf = useCallback((r: Row) => findKept(kept, r), [kept]);
  const liveOf = useCallback((k: Kept) => rows?.find((r) => matches(k, r)), [rows]);
  const rowByPid = (pid: number) => rows?.find((r) => r.pid === pid);

  const items: Item[] = useMemo(() => {
    if (mode === "kept") {
      return kept
        .map((k, index) => ({ type: "kept" as const, kept: k, index, live: liveOf(k) }))
        .filter(({ kept: k }) => !q || `${k.name} ${k.command} ${k.cwd} ${k.note ?? ""} ${(k.ports ?? []).join(" ")}`.toLowerCase().includes(q));
    }
    if (!rows) return [];
    const memberHit = (m: Member) => `${m.argvCommand} ${m.cwd} ${m.listen.map((l) => l.port).join(" ")}`.toLowerCase().includes(q);
    const visible = rows.filter((r) => {
      if (!showAll && r.kind === "app") return false;
      if (!q) return true;
      const k = keptOf(r);
      const title = agentInfo(r)?.title ?? "";
      return `${r.command} ${r.cwd} ${r.where} ${r.ports.join(" ")} ${k?.name ?? ""} ${title}`.toLowerCase().includes(q) || r.members.some(memberHit);
    });
    const sections = new Map<string, Row[]>();
    for (const r of visible) sections.set(r.where, [...(sections.get(r.where) ?? []), r]);
    const rank = (rs: Row[]) => Math.min(...rs.map((r) => KIND_RANK[r.kind]));
    const ordered = [...sections.entries()].sort(([a, ra], [b, rb]) => rank(ra) - rank(rb) || a.localeCompare(b));

    const out: Item[] = [];
    const spec = SORTS[sort.key];
    const dir = sort.desc ? -1 : 1;
    // Compare jobs, groups (by their aggregate) and processes with the same key.
    const cmpVal = (a: number | string, b: number | string) =>
      (typeof a === "string" ? a.localeCompare(b as string) : a - (b as number)) * dir;
    const jobVal = (r: Row) => spec.value({ rss: r.rssKb, cpu: r.cpu, age: r.etimeSec, name: agentInfo(r)?.title ?? r.command });
    const groupVal = (rs: Row[], label: string) =>
      spec.group === "label" ? label : spec.group === "max"
        ? Math.max(...rs.map((r) => jobVal(r) as number))
        : rs.reduce((sum, r) => sum + (jobVal(r) as number), 0);
    const byKey = (a: Row, b: Row) => cmpVal(jobVal(a), jobVal(b)) || a.pid - b.pid;
    const byOldest = byKey;
    if (sort.key !== "started" && sort.key !== "name") ordered.sort(([a, ra], [b, rb]) => cmpVal(groupVal(ra, a), groupVal(rb, b)));
    for (const [where, rs] of ordered) {
      const isApp = rs.every((r) => r.kind === "app");
      out.push({
        type: "header",
        label: where === "detached" ? "Detached" : where,
        tag: where === "detached" ? "no terminal" : isApp ? "app" : undefined,
        count: rs.length,
        muted: isApp,
      });
      const inSection = new Set(rs.map((r) => r.pid));
      const place = (r: Row, depth: number) => {
        out.push({ type: "row", row: r, depth });
        // Expanded (or the filter matched one of its processes): show its processes as a tree.
        if (r.members.length && (expanded.has(r.pid) || (q && r.members.some(memberHit)))) {
          const members = sortTree(r.members, (m) => spec.value({ rss: m.rssKb, cpu: m.cpu, age: m.etimeSec, name: m.argvCommand }), cmpVal);
          // Tree lines: "│  " under ancestors that have more siblings below, "├─"/"└─" for the node.
          const isLast = (i: number) => {
            const m = members[i]!;
            for (let j = i + 1; j < members.length && members[j]!.depth >= m.depth; j++)
              if (members[j]!.depth === m.depth) return false;
            return true;
          };
          const open: boolean[] = [];
          members.forEach((m, i) => {
            const last = isLast(i);
            const prefix = open.slice(0, m.depth).map((o) => (o ? "│  " : "   ")).join("") + (last ? "└─ " : "├─ ");
            open[m.depth] = !last;
            out.push({ type: "child", row: r, m, prefix });
          });
        }
        rs.filter((x) => x.parentRow === r.pid).sort(byOldest).forEach((x) => place(x, depth + 1));
      };
      // Within an app: one block per starting directory.
      const tops = rs.filter((r) => r.parentRow === undefined || !inSection.has(r.parentRow));
      const dirs = new Map<string, Row[]>();
      for (const r of tops) dirs.set(r.cwd, [...(dirs.get(r.cwd) ?? []), r]);
      const dirOrder = ([a, ra]: [string, Row[]], [b, rb]: [string, Row[]]) =>
        sort.key === "started" || sort.key === "name" ? tildify(a).localeCompare(tildify(b)) : cmpVal(groupVal(ra, a), groupVal(rb, b));
      for (const [dir, drs] of [...dirs.entries()].sort(dirOrder)) {
        out.push({ type: "dir", dir, branch: dir && dir !== "/" ? gitBranch(dir) : null, count: drs.length, muted: isApp });
        drs.sort(byOldest).forEach((r) => place(r, 0));
      }
    }
    return out;
  }, [mode, rows, kept, showAll, q, keptOf, liveOf, expanded, sort]);

  const selectable = useMemo(() => items.flatMap((it, i) => (it.type === "header" || it.type === "dir" ? [] : [i])), [items]);
  const keyOf = (it: Item | undefined) => (it?.type === "row" ? it.row.pid : it?.type === "child" ? it.m.pid : undefined);

  // Keep the selection on the same process across refreshes.
  let pos =
    mode === "procs"
      ? selectable.findIndex((i) => keyOf(items[i]) === sel.procs)
      : selectable.findIndex((i) => (items[i] as { index: number }).index === sel.kept);
  if (pos < 0) pos = Math.min(lastPos.current[mode], Math.max(0, selectable.length - 1));
  lastPos.current[mode] = pos;
  const cursorItem = selectable.length ? items[selectable[pos]!] : undefined;
  const curChild = cursorItem?.type === "child" ? cursorItem.m : undefined;
  const curRow =
    cursorItem?.type === "row" || cursorItem?.type === "child" ? cursorItem.row : cursorItem?.type === "kept" ? cursorItem.live : undefined;
  const curKept = cursorItem?.type === "kept" ? cursorItem.kept : curRow ? keptOf(curRow) : undefined;

  const select = (p: number) => {
    const clamped = Math.max(0, Math.min(selectable.length - 1, p));
    const it = items[selectable[clamped]!];
    if (!it) return;
    lastPos.current[mode] = clamped;
    const k = keyOf(it);
    if (k !== undefined) setSel((s) => ({ ...s, procs: k }));
    if (it.type === "kept") setSel((s) => ({ ...s, kept: it.index }));
  };
  const selectPid = (pid: number) => setSel((s) => ({ ...s, procs: pid }));
  const setOpen = (pid: number, open: boolean) =>
    setExpanded((e) => {
      const n = new Set(e);
      open ? n.add(pid) : n.delete(pid);
      return n;
    });

  // ── layout ─────────────────────────────────────────────────────────────
  const W = Math.max(60, size.w);
  const H = Math.max(18, size.h - 1); // one spare line: Ink clears the screen when output fills it
  const listH = H - 1 /*header*/ - 1 /*gap*/ - DETAILS_H - 1 /*footer*/;
  const bodyH = listH + DETAILS_H;

  // Scroll so the cursor (and the headers above it) stay visible.
  const cursorIdx = selectable[pos] ?? 0;
  let viewTop = top;
  if (cursorIdx < viewTop) {
    viewTop = cursorIdx;
    while (viewTop > 0 && (items[viewTop - 1]?.type === "header" || items[viewTop - 1]?.type === "dir")) viewTop--;
  }
  if (cursorIdx >= viewTop + listH) viewTop = cursorIdx - listH + 1;
  viewTop = Math.max(0, Math.min(viewTop, Math.max(0, items.length - listH)));
  if (viewTop !== top) queueMicrotask(() => setTop(viewTop));

  // ── peek: live-refresh while open ──────────────────────────────────────
  const peekOverlay = overlay?.type === "peek" ? overlay : null;
  useEffect(() => {
    if (!peekOverlay) return setPeekData(null);
    const load = () => {
      const r = rowByPid(peekOverlay.pid);
      if (!r) return;
      const src = peekOverlay.source;
      const m = peekOverlay.child ? r.members.find((x) => x.pid === peekOverlay.child) : undefined;
      if (m) {
        // A single process: its own log files first, else the job's terminal.
        const cr = childRow(r, m);
        const files = outputFiles(cr);
        setPeekData(files.length ? peek(cr, Math.max(200, bodyH), src ?? files[0]) : peek(r, Math.max(200, bodyH), src));
        return;
      }
      const data = peek(r, Math.max(200, bodyH), src === TRANSCRIPT ? undefined : src);
      const a = agentInfo(r);
      if (a?.transcript) data.sources = [TRANSCRIPT, ...data.sources];
      if (src === TRANSCRIPT && a) setPeekData({ ...data, title: `${a.harness} conversation — ${a.transcript}`, lines: transcriptTail(a, bodyH) });
      else setPeekData(data);
    };
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [peekOverlay?.pid, peekOverlay?.child, peekOverlay?.source]);

  // ── actions ────────────────────────────────────────────────────────────
  const askKill = (r: Row, m?: Member, forceNow = false) => {
    const key = m?.pid ?? r.pid;
    const st = stopping.get(key);
    // Already force-killed and still here: explain instead of asking again.
    if (st?.force && Date.now() - st.at > 1500) {
      const target = m ? m.pid : r.leaderGone ? r.pids.find((p) => p !== r.pgid && isAlive(p)) ?? r.pid : r.pid;
      const why = unkillableReason(target);
      return flash(why ? `pid ${target}: ${why}` : `pid ${target} is still there — it may be restarted by its parent or by launchd`, "warn");
    }
    const force = forceNow || (!!st && Date.now() - st.at > STUCK_AFTER_MS);
    const cmd = m ? m.argvCommand : r.command;
    const label = cmd.length > 40 ? cmd.slice(0, 39) + "…" : cmd;
    const pids = m ? m.pids : r.pids;
    setConfirm({
      text: `${force ? "Force-kill (kill -9 — no chance to clean up)" : "Stop"} ${label} — ${pids.length > 1 ? `${pids.length} processes` : `pid ${key}`}${m ? " (just this part of the job)" : ""}?`,
      onYes: () => {
        const sig = force ? "SIGKILL" : "SIGTERM";
        const n = m ? killPids(m.pids, sig) : killRow(r, sig);
        setStopping((s) => new Map(s).set(key, { at: Date.now(), force }));
        flash(n ? `sent ${sig}` : "already gone", "warn");
        setTimeout(refresh, 400);
      },
    });
  };

  /** Put a line on the user's prompt (via the shell function), or print + copy it as a fallback. */
  const handToShell = (dir: string, line: string) => {
    const res = handOff(dir, line);
    if (res.how === "copy") props.onExit({ print: res.full, copied: true });
    exit();
  };

  const startKept = (k: Kept, how: "prompt" | "tmux") => {
    const go = () => {
      if (how === "tmux") {
        const res = toTmux(k);
        flash(res.message, res.ok ? "ok" : "err");
        setTimeout(refresh, 1000);
        return;
      }
      handToShell(untildify(k.cwd), commandLine(k));
    };
    const live = liveOf(k);
    if (live) setConfirm({ text: `"${k.name}" is already running (${live.where}). Start another?`, onYes: go });
    else go();
  };

  const openWeb = (r: Row, m?: Member) => {
    const listen = m ? m.listen : r.listen;
    const pages = webPages(listen, probes);
    if (pages.length === 1 || (m && pages.length)) {
      openUrl(pages[0]!.url);
      return flash(`opened ${pages[0]!.url}${pages[0]!.title ? ` — ${pages[0]!.title}` : ""}`);
    }
    if (pages.length > 1) {
      // Several pages: show the job's processes and put the cursor on the first page.
      const first = r.members.find((x) => x.listen.some((l) => isWeb(l, probes)));
      setOpen(r.pid, true);
      if (first) selectPid(first.pid);
      return flash(`${pages.length} web pages — pick one (↑↓, o)`);
    }
    if (!listen.length) return flash("not listening on any port", "warn");
    const pending = listen.some((l) => probes.get(probeKey(l)) === "pending");
    flash(pending ? "still checking its ports…" : "its ports don't serve web pages (API or other protocol)", "warn");
  };

  const doFocus = (r: Row) => {
    const res = focus(r);
    if (res.prompt) return handToShell("", res.prompt);
    flash(res.message, res.ok ? "ok" : "warn");
  };

  const restart = (r: Row, k?: Kept) => {
    const res = planRestart(r, k);
    if (!res.ok) return flash(res.reason, "warn");
    const p = res.plan;
    const short = p.line.length > 60 ? p.line.slice(0, 59) + "…" : p.line;
    setConfirm({
      text: `Restart: stop ${r.pids.length > 1 ? `${r.pids.length} processes` : "it"}, then run \`${short}\` in ${p.whereLabel} (${p.why})${p.exact ? "" : " — not verified"}?`,
      onYes: () => {
        setStopping((s) => new Map(s).set(r.pid, { at: Date.now(), force: false }));
        const name = k?.name ?? agentInfo(r)?.harness ?? base(p.line.split(/\s+/)[0] ?? "restart");
        runRestart(r, p, name, (msg) => flash(msg, "warn")).then((out) => {
          if (out.prompt) return handToShell(out.prompt.cwd, out.prompt.line);
          flash(out.message, out.ok ? "ok" : "err");
          setTimeout(refresh, 800);
        });
      },
    });
  };

  const copy = (dir: string, cmd: string) => {
    const line = `cd ${shellPath(dir)} && ${cmd}`;
    Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(line) });
    flash(`copied: ${line}`);
  };

  useInput(
    (input, key) => {
      if (sortMenu) {
        setSortMenu(false);
        if (input === "r") {
          setSort((s) => ({ ...s, desc: !s.desc }));
          return flash(`sorted by ${SORTS[sort.key].label} — ${SORTS[sort.key].dirLabel[sort.desc ? 0 : 1]}`);
        }
        const pick = (Object.keys(SORTS) as SortKey[]).find((k) => SORTS[k].key === input);
        if (pick) {
          setSort({ key: pick, desc: SORTS[pick].desc });
          return flash(`sorted by ${SORTS[pick].label} — ${SORTS[pick].dirLabel[SORTS[pick].desc ? 1 : 0]}`);
        }
        return; // esc or any other key: leave the sort as it is
      }
      if (confirm) {
        if (input === "y" || input === "Y") confirm.onYes();
        setConfirm(null);
        return;
      }
      if (filtering) {
        if (key.escape) { setFilter(""); setFiltering(false); return; }
        if (key.return) { setFiltering(false); return; }
        if (key.backspace || key.delete) { setFilter((f) => f.slice(0, -1)); return; }
        if (!key.upArrow && !key.downArrow && input && !key.ctrl && !key.meta) { setFilter((f) => f + input.replace(/[\x00-\x1f]/g, "")); return; }
      }
      if (input === "q" || (key.ctrl && input === "c")) return exit();
      if (input === "?") return setOverlay({ type: "help" });
      if (key.escape && filter) return setFilter("");
      if (key.tab || input === "\t") { setMode((m) => (m === "procs" ? "kept" : "procs")); setTop(0); setFilter(""); return; }
      if (key.upArrow || input === "k") return select(pos - 1);
      if (key.downArrow || input === "j") return select(pos + 1);
      if (key.pageUp) return select(pos - listH);
      if (key.pageDown) return select(pos + listH);
      if (key.home || input === "g") return select(0);
      if (key.end || input === "G") return select(selectable.length - 1);
      if (input === "/") { setFiltering(true); return; }
      if (input === "r") { refresh(); return flash("refreshed"); }

      // Tree: → expands a job (then steps into it), ← collapses / goes back to the job.
      if (mode === "procs" && (key.rightArrow || input === "l") && cursorItem?.type === "row" && cursorItem.row.members.length) {
        if (!expanded.has(cursorItem.row.pid)) return setOpen(cursorItem.row.pid, true);
        return select(pos + 1);
      }
      if (mode === "procs" && (key.leftArrow || input === "h")) {
        if (cursorItem?.type === "child") { setOpen(cursorItem.row.pid, false); return selectPid(cursorItem.row.pid); }
        if (cursorItem?.type === "row") return setOpen(cursorItem.row.pid, false);
      }

      // Actions on one process of a job.
      if (curRow && curChild) {
        if (input === "o") return openWeb(curRow, curChild);
        if (input === "p") return setOverlay({ type: "peek", pid: curRow.pid, child: curChild.pid });
        if (input === "x") return askKill(curRow, curChild);
        if (input === "X") return askKill(curRow, curChild, true);
        if (input === "c") return copy(curChild.cwd, curChild.argvCommand);
        if (input === "f") return doFocus(curRow);
        if (input === " " || input === "R")
          return flash(`this process is part of "${curRow.command}" — ${input === " " ? "keep" : "restart"} the whole job from its row (←)`, "warn");
        return;
      }

      // Actions on a live job work in both tabs.
      if (curRow) {
        if (input === "o") return openWeb(curRow);
        if (input === "f") return doFocus(curRow);
        if (input === "p") return setOverlay({ type: "peek", pid: curRow.pid });
        if (input === "c") return copy(curRow.cwd, curRow.command);
        if (input === "x") return askKill(curRow);
        if (input === "X") return askKill(curRow, undefined, true);
        if (input === "R") return restart(curRow, curKept);
      }

      if (mode === "procs") {
        if (input === "a") { setShowAll((s) => !s); return flash(showAll ? "hiding app & system servers" : "showing app & system servers too"); }
        if (input === "s") { setStatus(null); return setSortMenu(true); }
        if (curRow && input === " ") {
          const k = keptOf(curRow);
          if (k) return flash(`already kept as "${k.name}" — edit it in the Kept tab`, "warn");
          return setOverlay({ type: "keep", row: curRow });
        }
      } else {
        const it = cursorItem?.type === "kept" ? cursorItem : undefined;
        if (!it) return;
        if (key.return) return startKept(it.kept, "prompt");
        if (input === "t") return startKept(it.kept, "tmux");
        if (input === "e") return setOverlay({ type: "edit", index: it.index });
        if (input === "R") return startKept(it.kept, "prompt");
        if (input === "x" || input === "o" || input === "f" || input === "p") return flash("not running", "warn");
        if (input === "d")
          return setConfirm({
            text: `Forget "${it.kept.name}"? (the process itself is not touched)`,
            onYes: () => { persist(kept.filter((_, i) => i !== it.index)); flash(`forgot "${it.kept.name}"`, "warn"); },
          });
      }
    },
    { isActive: !overlay },
  );

  // Keys for the simple overlays (help, peek). Forms handle their own.
  useInput(
    (input, key) => {
      if (!overlay) return;
      if (key.escape || input === "q" || (overlay.type === "help" && input === "?")) return setOverlay(null);
      if (overlay.type === "peek") {
        const srcs = peekData?.sources ?? [];
        if ((key.leftArrow || key.rightArrow) && srcs.length) {
          const cur = overlay.source ? srcs.indexOf(overlay.source) : -1;
          const next = key.rightArrow ? cur + 1 : cur - 1;
          // index -1 = the terminal view (if any), then the agent conversation, then each log file
          setOverlay({ ...overlay, source: next < 0 || next >= srcs.length ? undefined : srcs[next] });
        }
        if (input === "f") { const r = rowByPid(overlay.pid); if (r) { setOverlay(null); doFocus(r); } }
      }
    },
    { isActive: !!overlay && overlay.type !== "keep" && overlay.type !== "edit" },
  );

  // ── forms ──────────────────────────────────────────────────────────────
  const formFor = (o: Extract<Overlay, { type: "keep" | "edit" }>) => {
    const toEnv = (v: FormValues) => Object.fromEntries(v.env.filter((e) => e.selected).map((e) => [e.key, e.value]));
    if (o.type === "keep") {
      const r = o.row;
      const agent = agentInfo(r);
      const words = r.command.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      const prog = base(words[0] ?? "");
      const sub = /^(npm|pnpm|yarn|bun|just|make)$/.test(prog) ? words.filter((a) => a !== "run")[1] : undefined;
      return {
        title: r.leaderGone
          ? `Keep "${r.command}" — the command that started ${r.pids.length === 1 ? "this process" : `these ${r.pids.length} processes`}`
          : "Keep this process",
        initial: {
          // An agent: keep the conversation (a clean resume command), named after its title.
          name: agent?.title ? `${agent.harness}: ${agent.title.slice(0, 40)}` : `${basename(r.cwd) || prog} ${sub ?? prog}`.trim(),
          command: agent?.resume ?? r.command,
          cwd: tildify(r.cwd),
          note: "",
          env: agent ? [] : envChoices(r.env, r.baseEnv, process.env, prefixVars(r.command)),
        },
        save: (v: FormValues) => {
          const dup = kept.find((x) => sameEntry(x, { command: v.command, cwd: v.cwd }));
          if (dup) return flash(`already kept as "${dup.name}"`, "warn");
          const session = agent?.sessionId && v.command.includes(agent.sessionId) ? agent.sessionId : undefined;
          persist([...kept, { name: v.name || prog, command: v.command, cwd: v.cwd, env: toEnv(v), note: v.note, ports: r.ports, session, kept: new Date().toISOString() }]);
          flash(`kept "${v.name}" ✓`);
        },
      };
    }
    const k = kept[o.index]!;
    return {
      title: `Edit "${k.name}"`,
      initial: {
        name: k.name, command: k.command, cwd: k.cwd, note: k.note ?? "",
        env: Object.entries(k.env ?? {}).map(([key, value]) => ({ key, value, secret: false, selected: true })),
      },
      save: (v: FormValues) => {
        persist(kept.map((x, i) => (i === o.index ? { ...x, name: v.name, command: v.command, cwd: v.cwd, note: v.note, env: toEnv(v) } : x)));
        flash(`saved "${v.name}" ✓`);
      },
    };
  };

  // ── render ─────────────────────────────────────────────────────────────
  const procCount = rows ? rows.filter((r) => showAll || r.kind !== "app").length : 0;
  const header = (
    <Box width={W}>
      <Text color={c.accent} bold> running </Text>
      <Text color={c.faint}>│ </Text>
      <Tab active={mode === "procs"} label="Processes" count={procCount} />
      <Text> </Text>
      <Tab active={mode === "kept"} label="Kept" count={kept.length} />
      <Box flexGrow={1} />
      {filtering || filter ? (
        <Text>
          <Text color={c.accent}>/ </Text>
          <Text color={c.fg}>{filter}</Text>
          {filtering && <Text inverse> </Text>}
        </Text>
      ) : mode === "procs" && showAll ? (
        <Text color={c.muted}>showing app & system servers </Text>
      ) : (
        <Text>
          {mode === "procs" && rows && (
            <Text color={sort.key === "started" && !sort.desc ? c.faint : c.accent}>
              {`${SORTS[sort.key].label} ${sort.desc ? "↓" : "↑"}   `}
            </Text>
          )}
          <Text color={c.faint}>{rows ? `v${pkg.version}  ? help ` : "scanning… "}</Text>
        </Text>
      )}
    </Box>
  );

  let body: React.ReactNode;
  if (overlay?.type === "keep" || overlay?.type === "edit") {
    const f = formFor(overlay);
    body = (
      <Form
        key={overlay.type === "keep" ? `k${overlay.row.pid}` : `e${overlay.index}`}
        title={f.title}
        initial={f.initial}
        width={W}
        height={bodyH}
        onCancel={() => setOverlay(null)}
        onSubmit={(v) => { f.save({ ...v, name: v.name.trim(), command: v.command.trim(), cwd: v.cwd.trim(), note: v.note.trim() }); setOverlay(null); }}
      />
    );
  } else if (overlay?.type === "peek") {
    const r = rowByPid(overlay.pid);
    const m = overlay.child ? r?.members.find((x) => x.pid === overlay.child) : undefined;
    const label = m ? m.argvCommand : r ? (agentInfo(r)?.title ? `${agentInfo(r)!.harness}: ${agentInfo(r)!.title}` : r.command) : "(gone)";
    body = <PeekView width={W} height={bodyH} label={label} data={peekData} />;
  } else if (overlay?.type === "help") {
    body = <HelpView width={W} height={bodyH} />;
  } else {
    const slice = items.slice(viewTop, viewTop + listH);
    body = (
      <>
        <Box flexDirection="column" height={listH}>
          {slice.length === 0 && <Empty mode={mode} loading={!rows} filtered={!!filter} />}
          {slice.map((it, i) => {
            const idx = viewTop + i;
            const selected = idx === cursorIdx;
            if (it.type === "header") return <SectionHeader key={`h${idx}`} {...it} width={W} />;
            if (it.type === "dir") return <DirHeader key={`d${idx}`} {...it} width={W} />;
            if (it.type === "row")
              return (
                <ProcLine key={it.row.pid} row={it.row} depth={it.depth} kept={keptOf(it.row)} selected={selected} width={W}
                  stop={stopping.get(it.row.pid)} probes={probes} open={expanded.has(it.row.pid) || (!!q && items[idx + 1]?.type === "child")} />
              );
            if (it.type === "child")
              return <ChildLine key={`c${it.m.pid}`} row={it.row} m={it.m} prefix={it.prefix} selected={selected} width={W} probes={probes} stop={stopping.get(it.m.pid)} />;
            return <KeptLine key={`k${it.index}`} kept={it.kept} live={it.live} selected={selected} width={W} probes={probes} />;
          })}
        </Box>
        <Details width={W} height={DETAILS_H} mode={mode} row={curRow} child={curChild} kept={curKept} probes={probes} open={!!curRow && expanded.has(curRow.pid)} />
      </>
    );
  }

  return (
    <Box flexDirection="column" width={W} height={H}>
      {header}
      <Text> </Text>
      {body}
      <Footer width={W} mode={mode} overlay={overlay?.type} sortMenu={sortMenu ? sort : null} confirm={confirm} status={status} filtering={filtering} row={curRow} child={curChild} probes={probes} open={!!curRow && expanded.has(curRow.pid)} />
    </Box>
  );
}

/** Unusual process states worth a glance: zombie, stopped (Ctrl-Z), stuck in the kernel. */
const stateLabel = (stat: string) => (stat.startsWith("Z") ? "zombie" : stat.startsWith("T") ? "paused" : stat.startsWith("U") ? "D-wait" : null);

/** Re-order a tree-ordered member list so siblings follow `value`, keeping parents above children. */
function sortTree(members: Member[], value: (m: Member) => number | string, cmp: (a: number | string, b: number | string) => number): Member[] {
  const pids = new Set(members.map((m) => m.pid));
  const kids = new Map<number, Member[]>();
  const tops: Member[] = [];
  for (const m of members) (pids.has(m.ppid) ? kids.set(m.ppid, [...(kids.get(m.ppid) ?? []), m]) : tops.push(m));
  const out: Member[] = [];
  const walk = (list: Member[]) => {
    for (const m of [...list].sort((a, b) => cmp(value(a), value(b)) || a.pid - b.pid)) {
      out.push(m);
      walk(kids.get(m.pid) ?? []);
    }
  };
  walk(tops);
  return out;
}

function agentBadge(a: AgentInfo): string {
  if (a.status === "new") return a.title ? "· new ·" : "· new";
  if (a.status === "working") return "· ⟳ working ·";
  const idle = a.lastActive ? fmtUptime(Math.max(0, Math.round(Date.now() / 1000 - a.lastActive))) : "";
  return idle ? `· idle ${idle} ·` : "·";
}

function AgentLine({ a }: { a: AgentInfo }) {
  const idle = a.lastActive ? `${fmtUptime(Math.max(0, Math.round(Date.now() / 1000 - a.lastActive)))} ago` : "";
  return (
    <Text wrap="truncate-end">
      <Text color={c.magenta}>{a.harness}</Text>
      {a.status === "new" ? (
        <Text color={c.dim}>  no conversation yet</Text>
      ) : (
        <>
          <Text color={a.status === "working" ? c.yellow : c.dim}>  {a.status === "working" ? "⟳ working" : `idle · last activity ${idle}`}</Text>
          {a.model && <><Dot />{L("model", a.model)}</>}
          {a.tokens !== undefined && <><Dot />{L("tokens", fmtTokens(a.tokens))}</>}
          {a.costUsd !== undefined && <><Dot />{L("cost", `$${a.costUsd.toFixed(2)}`)}</>}
          {a.branch && <><Dot />{L("branch", a.branch)}</>}
          {a.sessionId && <><Dot />{L("session", a.sessionId.slice(0, 8))}</>}
        </>
      )}
    </Text>
  );
}

const shellPath = (p: string) => (/^[\w./~+-]+$/.test(tildify(p)) ? tildify(p) : `'${p.replace(/'/g, `'\\''`)}'`);

// ── pieces ───────────────────────────────────────────────────────────────

function Tab({ active, label, count }: { active: boolean; label: string; count: number }) {
  return active ? (
    <Text backgroundColor={c.accent} color={c.accentFg} bold> {label} {count} </Text>
  ) : (
    <Text color={c.dim}> {label} <Text color={c.faint}>{count}</Text> </Text>
  );
}

function SectionHeader({ label, tag, count, width, muted }: { label: string; tag?: string; count: number; width: number; muted: boolean }) {
  const head = ` ${label} `;
  const meta = `${tag ? `· ${tag} ` : ""}· ${count} `;
  const rule = "─".repeat(Math.max(0, width - head.length - meta.length - 3));
  return (
    <Text>
      <Text color={muted ? c.muted : c.magenta} bold>{head}</Text>
      <Text color={c.dim}>{meta}</Text>
      <Text color={c.faint}>{rule}</Text>
    </Text>
  );
}

/** A starting directory inside an app section: the whole row is the path (+ git branch). */
function DirHeader({ dir, branch, count, width, muted }: { dir: string; branch: string | null; count: number; width: number; muted: boolean }) {
  const path = dir ? tildify(dir) : "(unknown directory)";
  const tail = `${branch ? `  ⎇ ${branch}` : ""}${count > 1 ? `  · ${count}` : ""}`;
  const room = Math.max(10, width - 4 - tail.length);
  return (
    <Text wrap="truncate">
      <Text>   </Text>
      <Text color={muted ? c.muted : c.dirFg} bold>{fit(path, Math.min(room, path.length), "left")}</Text>
      {branch && <Text color={c.branch}>  ⎇ {branch}</Text>}
      {count > 1 && <Text color={c.faint}>  · {count}</Text>}
    </Text>
  );
}

function columns(width: number) {
  const ports = 16, up = 6, mem = 6;
  const cwd = Math.max(14, Math.min(44, Math.round(width * 0.24)));
  const cmd = width - 4 - ports - cwd - up - mem - 4 - 1;
  return { ports, up, mem, cwd, cmd };
}

/** Process list columns: the directory lives in the header line, so the command gets the room. */
function procColumns(width: number) {
  const ports = 16, up = 6, mem = 6;
  return { ports, up, mem, cmd: width - 4 - ports - up - mem - 3 - 1 };
}

/** Ports, web pages first-class: `↗3000 :3001 +3`. */
function PortsCell({ listen, probes, width, muted }: { listen: Listen[]; probes: Probes; width: number; muted?: boolean }) {
  const toks = listen.map((l) => {
    const web = isWeb(l, probes);
    return { text: `${web ? "↗" : ":"}${l.port}`, web };
  });
  toks.sort((a, b) => Number(b.web) - Number(a.web)); // web ports first: they're the ones you'd open
  const out: typeof toks = [];
  let used = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const rest = toks.length - i - 1;
    const need = t.text.length + (out.length ? 1 : 0) + (rest ? ` +${rest}`.length : 0);
    if (used + need > width) break;
    out.push(t);
    used += t.text.length + (out.length > 1 ? 1 : 0);
  }
  const more = toks.length - out.length;
  const tail = more ? ` +${more}` : "";
  return (
    <Text>
      {out.map((t, i) => (
        <Text key={i} color={muted ? c.muted : t.web ? c.cyan : c.dimCyan} bold={t.web && !muted}>{(i ? " " : "") + t.text}</Text>
      ))}
      <Text color={c.dim}>{tail}</Text>
      <Text>{" ".repeat(Math.max(0, width - used - tail.length))}</Text>
    </Text>
  );
}

const ROW_INDENT = "  "; // rows sit under their directory header

function ProcLine(props: { row: Row; depth: number; kept?: Kept; selected: boolean; width: number; stop?: { at: number; force: boolean }; probes: Probes; open: boolean }) {
  const { row: r, kept, selected } = props;
  const muted = r.kind === "app"; // only visible in the "all" view
  const col = procColumns(props.width);
  const bg = selected ? c.selBg : undefined;
  const indent = ROW_INDENT + (props.depth ? "  ".repeat(props.depth - 1) + "└ " : "");
  const toggle = r.members.length ? (props.open ? "▾ " : "▸ ") : "  ";
  const agent = agentInfo(r);
  const [prog = "", ...restArgs] = r.command === r.argvCommand ? r.displayArgv : r.command.split(/\s+/);
  // Agents: what the conversation is about beats a wall of flags.
  const rest = agent ? [agentBadge(agent), agent.title ?? ""] : restArgs;
  const progName = prog.includes("/") && !prog.startsWith(".") ? basename(prog) : prog;
  const name = kept ? `${kept.name}  ` : "";
  const note = r.leaderGone ? "  ⤷ exited" : "";
  const count = r.members.length && !props.open ? `  ${r.members.length} proc${r.members.length > 1 ? "s" : ""}` : "";
  const room = col.cmd - indent.length - toggle.length;
  const progShown = fit(name + progName, room).trimEnd();
  const argsRoom = Math.max(0, room - progShown.length);
  const tailLen = note.length + count.length;
  const argsText = fit(" " + rest.join(" "), Math.max(0, argsRoom - tailLen)).trimEnd();
  const tailRoom = Math.max(0, argsRoom - argsText.length);
  const noteShown = note.slice(0, tailRoom);
  const countShown = count.slice(0, Math.max(0, tailRoom - noteShown.length));
  const pad = " ".repeat(Math.max(0, argsRoom - argsText.length - noteShown.length - countShown.length));
  const stuck = props.stop && Date.now() - props.stop.at > STUCK_AFTER_MS;
  const fg = muted ? c.muted : c.fg;

  return (
    <Text backgroundColor={bg} wrap="truncate">
      <Text color={c.accent}>{selected ? "▌" : " "}</Text>
      <Text color={c.green}>{kept ? "● " : "  "}</Text>
      <Text color={c.faint}>{indent}</Text>
      <Text color={c.dim}>{toggle}</Text>
      {kept ? (
        <Text>
          <Text color={c.green} bold>{progShown.slice(0, Math.min(name.length, progShown.length))}</Text>
          <Text color={fg} bold>{progShown.slice(name.length)}</Text>
        </Text>
      ) : (
        <Text color={fg} bold={!muted} italic={r.source === "history"}>{progShown}</Text>
      )}
      <Text color={muted ? c.faint : selected ? c.fg : c.dim} italic={r.source === "history"}>{argsText}</Text>
      <Text color={c.yellow}>{noteShown}</Text>
      <Text color={c.faint}>{countShown}</Text>
      <Text>{pad} </Text>
      <PortsCell listen={r.listen} probes={props.probes} width={col.ports} muted={muted} />
      <Text> </Text>
      {props.stop ? (
        <Text color={stuck ? c.red : c.yellow}>{(stuck ? "stuck" : "stop…").padStart(col.up)}</Text>
      ) : stateLabel(r.stat) ? (
        <Text color={c.red}>{stateLabel(r.stat)!.padStart(col.up)}</Text>
      ) : (
        <Text color={muted ? c.faint : c.dim}>{fmtUptime(r.etimeSec).padStart(col.up)}</Text>
      )}
      <Text> </Text>
      <Text color={r.rssKb > 1024 * 1024 && !muted ? c.yellow : muted ? c.faint : c.dim}>{fmtMem(r.rssKb).padStart(col.mem)}</Text>
      <Text> </Text>
    </Text>
  );
}

/** One process inside an expanded job: tree-drawn, its own ports/uptime/memory. */
function ChildLine(props: { row: Row; m: Member; prefix: string; selected: boolean; width: number; probes: Probes; stop?: { at: number; force: boolean } }) {
  const { row: r, m, selected } = props;
  const col = procColumns(props.width);
  const indent = ROW_INDENT + "  ";
  const branch = props.prefix;
  const [prog = "", ...args] = m.displayArgv;
  const progName = prog.includes("/") ? basename(prog) : prog;
  // Where it runs, relative to the job's directory — only when different.
  const rel = m.cwd && m.cwd !== r.cwd ? (m.cwd.startsWith(r.cwd + "/") ? relative(r.cwd, m.cwd) : tildify(m.cwd)) : "";
  const where = rel ? `  @${rel}` : "";
  const room = col.cmd - indent.length - branch.length;
  const progShown = fit(progName, room).trimEnd();
  const argsRoom = Math.max(0, room - progShown.length);
  const whereShown = where.slice(0, Math.max(0, Math.min(where.length, argsRoom - 8)));
  const argsText = fit(" " + args.map(shortArg).join(" "), Math.max(0, argsRoom - whereShown.length)).trimEnd();
  const pad = " ".repeat(Math.max(0, argsRoom - argsText.length - whereShown.length));
  const stuck = props.stop && Date.now() - props.stop.at > STUCK_AFTER_MS;
  return (
    <Text backgroundColor={selected ? c.selBg : undefined} wrap="truncate">
      <Text color={c.accent}>{selected ? "▌" : " "}</Text>
      <Text>  </Text>
      <Text color={c.faint}>{indent}{branch}</Text>
      <Text color={c.childFg}>{progShown}</Text>
      <Text color={selected ? c.childFg : c.faint}>{argsText}</Text>
      <Text color={c.dirFg}>{whereShown}</Text>
      <Text>{pad} </Text>
      <PortsCell listen={m.listen} probes={props.probes} width={col.ports} />
      <Text> </Text>
      {props.stop ? (
        <Text color={stuck ? c.red : c.yellow}>{(stuck ? "stuck" : "stop…").padStart(col.up)}</Text>
      ) : stateLabel(m.stat) ? (
        <Text color={c.red}>{stateLabel(m.stat)!.padStart(col.up)}</Text>
      ) : (
        <Text color={c.faint}>{fmtUptime(m.etimeSec).padStart(col.up)}</Text>
      )}
      <Text> </Text>
      <Text color={m.rssKb > 1024 * 1024 ? c.yellow : c.faint}>{fmtMem(m.rssKb).padStart(col.mem)}</Text>
      <Text> </Text>
    </Text>
  );
}

/** `/very/long/node_modules/.bun/next@16/…/next` → `…/next`: keep child rows readable. */
const shortArg = (a: string) => (a.startsWith("/") && a.length > 30 ? "…/" + basename(a) : tildify(a));

function KeptLine(props: { kept: Kept; live?: Row; selected: boolean; width: number; probes: Probes }) {
  const { kept: k, live, selected } = props;
  const col = columns(props.width);
  const nameW = Math.min(24, Math.max(10, Math.round(col.cmd * 0.3)));
  return (
    <Text backgroundColor={selected ? c.selBg : undefined} wrap="truncate">
      <Text color={c.accent}>{selected ? "▌" : " "}</Text>
      <Text color={live ? c.green : c.faint}>{live ? " ● " : " ○ "}</Text>
      <Text color={live ? c.green : c.fg} bold>{fit(k.name, nameW)}</Text>
      <Text> </Text>
      <Text color={selected ? c.fg : c.dim}>{fit(commandLine(k), col.cmd - nameW - 1)}</Text>
      <Text> </Text>
      {live ? (
        <PortsCell listen={live.listen} probes={props.probes} width={col.ports} />
      ) : (
        <Text color={c.faint}>{fit((k.ports ?? []).map((p) => `:${p}`).join(" "), col.ports)}</Text>
      )}
      <Text> </Text>
      <Text color={c.dim}>{fit(k.cwd, col.cwd, "left")}</Text>
      <Text> </Text>
      <Text color={c.dim}>{(live ? fmtUptime(live.etimeSec) : "").padStart(col.up)}</Text>
      <Text> </Text>
      <Text color={c.dim}>{(live ? fmtMem(live.rssKb) : "").padStart(col.mem)}</Text>
      <Text> </Text>
    </Text>
  );
}

const Dot = () => <Text color={c.faint}>  ·  </Text>;
const L = (label: string, value: string, color: string = c.fg) => (
  <Text>
    <Text color={c.dim}>{label} </Text>
    <Text color={color}>{value}</Text>
  </Text>
);

function termLabel(r: Row): string {
  const t = r.term;
  if (t.tmux) return `tmux ${t.tmux}`;
  if (t.orca) return "Orca tab";
  if (t.app) return t.app.replace(/^Apple_/, "");
  return "";
}

function Details(props: { width: number; height: number; mode: Mode; row?: Row; child?: Member; kept?: Kept; probes: Probes; open: boolean }) {
  const { row: r, kept: k, child: m } = props;
  const inner = props.width - 4;

  /** One process's pages in full (URL + title); a job only summarizes — the list shows the rest. */
  const webLine = (listen: Listen[], full: boolean) => {
    const pages = webPages(listen, props.probes);
    if (full && pages.length)
      return (
        <Text key="web" wrap="truncate-end">
          <Text color={c.dim}>web </Text>
          {pages.map((p, i) => (
            <Text key={p.url}>
              {i > 0 && <Text color={c.faint}>  ·  </Text>}
              <Text color={c.cyan} underline>{p.url.replace(/\/$/, "")}</Text>
              {p.title && <Text color={c.fg}> {p.title}</Text>}
            </Text>
          ))}
          <Text color={c.dim}>   </Text><Text color={c.accent}>o</Text><Text color={c.dim}> open</Text>
        </Text>
      );
    if (pages.length)
      return (
        <Text key="web" wrap="truncate-end">
          <Text color={c.dim}>web </Text>
          <Text color={c.cyan}>{pages.length === 1 ? pages[0]!.url.replace(/\/$/, "") : `${pages.length} pages`}</Text>
          {pages.length === 1 && pages[0]!.title && <Text color={c.fg}> {pages[0]!.title}</Text>}
          <Text color={c.dim}>   </Text><Text color={c.accent}>o</Text>
          <Text color={c.dim}>{pages.length === 1 ? " open" : props.open ? " pick one in the list" : " show them"}</Text>
        </Text>
      );
    if (listen.length) return <Text key="web" wrap="truncate-end">{L("ports", listen.map((l) => `:${l.port}`).join(" "), c.dimCyan)}<Text color={c.dim}>  (no web pages)</Text></Text>;
    return <Text key="web" color={c.faint}>no listening ports</Text>;
  };

  const origin = (r: Row) =>
    r.leaderGone ? (
      <Text color={c.yellow}>
        {r.source === "typed" ? "you ran" : r.source === "script" ? "started by" : r.source === "history" ? "probably started by" : "started by a command that"}{" "}
        {r.source !== "argv" && <Text bold>{r.command}</Text>}
        {r.source !== "argv" ? " — it exited, " : " exited — "}
        {r.pids.length === 1 ? "the process it started is" : `${r.pids.length} processes it started are`} still running
        {r.source === "history" && <Text color={c.dim}> (guessed from shell history)</Text>}
        {r.source === "script" && <Text color={c.dim}> (its package-script variables say so)</Text>}
      </Text>
    ) : r.source === "typed" && r.command !== r.argvCommand ? (
      <Text color={c.dim}>you typed this; the kernel sees: {r.argvCommand}</Text>
    ) : null;

  let lines: React.ReactNode[] = [];
  if (props.mode === "procs" && r && m) {
    lines = [
      <Text key="cmd" wrap="truncate-end"><Text color={c.accent}>$ </Text><Text color={c.fg}>{m.argvCommand}</Text></Text>,
      <Text key="where" wrap="truncate-end">
        {L("in", tildify(m.cwd) || "?")}<Dot /><Text color={c.dim}>part of </Text><Text color={c.fg} bold>{r.command}</Text>
      </Text>,
      <Text key="stats" wrap="truncate-end">
        {L("pid", String(m.pid))}{m.pids.length > 1 && <Text color={c.dim}> +{m.pids.length - 1} below it</Text>}<Dot />
        {L("up", fmtUptime(m.etimeSec))}<Dot />{L("mem", fmtMem(m.rssKb))}<Dot />{L("cpu", `${m.cpu.toFixed(1)}%`)}
      </Text>,
      webLine(m.listen, true),
      <Text key="note" color={c.dim}>
        one process of a job — <Text color={c.accent}>p</Text> its output, <Text color={c.accent}>x</Text> stop just this;
        keep / restart the whole job from its row (<Text color={c.accent}>←</Text>)
      </Text>,
    ];
  } else if (props.mode === "procs" && r) {
    const o = origin(r);
    const agent = agentInfo(r);
    lines = [
      <Text key="cmd" wrap="truncate-end"><Text color={c.accent}>$ </Text><Text color={c.fg} italic={r.source === "history"}>{r.command}</Text></Text>,
      <Text key="where" wrap="truncate-end">
        {L("in", tildify(r.cwd) || "?")}<Dot />{L("on", r.where + (r.tty !== "??" ? ` ${r.tty}` : ""))}
        {termLabel(r) && <Text color={c.dim}> ({termLabel(r)}, <Text color={c.accent}>f</Text> focus)</Text>}
        {r.via && <><Dot />{L("via", r.via)}</>}
      </Text>,
      <Text key="stats" wrap="truncate-end">
        {L("pid", r.leaderGone ? `${r.pgid} (exited)` : String(r.pid))}
        {r.members.length > 0 && (
          <Text color={c.dim}> +{r.members.length} process{r.members.length > 1 ? "es" : ""}{" "}
            {props.open ? <>(<Text color={c.accent}>←</Text> hide)</> : <>(<Text color={c.accent}>→</Text> show)</>}
          </Text>
        )}<Dot />
        {L("up", fmtUptime(r.etimeSec))}<Dot />{L("mem", fmtMem(r.rssKb))}<Dot />{L("cpu", `${r.cpu.toFixed(1)}%`)}
      </Text>,
      agent ? <AgentLine key="agent" a={agent} /> : webLine(r.listen, false),
      k ? (
        <Text key="kept" color={c.green}>● kept as "{k.name}"{k.note ? <Text color={c.dim}> — {k.note}</Text> : null}</Text>
      ) : (
        o ?? (
          <Text key="kept" color={c.dim}>
            not kept — <Text color={c.accent}>space</Text> to keep{r.kind === "app" ? " (started by an app; may not be re-runnable)" : ""}
          </Text>
        )
      ),
    ];
    if (k && o) lines.splice(4, 0, o);
  } else if (props.mode === "kept" && k) {
    lines = [
      <Text key="cmd" wrap="truncate-end"><Text color={c.accent}>$ </Text><Text color={c.fg}>{commandLine(k)}</Text></Text>,
      <Text key="where" wrap="truncate-end">
        {L("in", k.cwd)}<Dot />{L("kept", ago(k.kept))}{k.note && <><Dot />{L("note", k.note)}</>}
      </Text>,
      r ? (
        <Text key="live" wrap="truncate-end">
          <Text color={c.green}>● running</Text><Dot />{L("on", r.where + (r.tty !== "??" ? ` ${r.tty}` : ""))}
          <Dot />{L("up", fmtUptime(r.etimeSec))}<Dot />{L("mem", fmtMem(r.rssKb))}
        </Text>
      ) : (
        <Text key="live" color={c.dim}>
          ○ not running — <Text color={c.accent}>⏎</Text>{" "}
          {HANDOFF === "shell" ? "cd there and put it on your prompt" : HANDOFF === "type" ? "type it into this terminal (cd + command, you press Enter)" : "copy it to the clipboard"}
          , <Text color={c.accent}>t</Text> start in tmux
          {HANDOFF !== "shell" && <Text color={c.yellow}>  · shell function not loaded here — `exec zsh` or a new terminal</Text>}
        </Text>
      ),
      r ? (agentInfo(r) ? <AgentLine key="agent" a={agentInfo(r)!} /> : webLine(r.listen, true)) : <Text key="web"> </Text>,
      <Text key="env" wrap="truncate-end" color={c.dim}>
        {Object.keys(k.env ?? {}).length ? `env: ${Object.keys(k.env!).join(", ")}` : "no extra environment"}
      </Text>,
    ];
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c.faint} paddingX={1} width={props.width} height={props.height}>
      {lines.length ? lines.slice(0, props.height - 2).map((l, i) => <Box key={i} width={inner}>{l}</Box>) : <Text color={c.faint}>nothing selected</Text>}
    </Box>
  );
}

function PeekView(props: { width: number; height: number; label: string; data: Peek | null }) {
  const { data } = props;
  const room = props.height - 4;
  const lines = data ? data.lines.slice(-room) : [];
  const srcs = data?.sources ?? [];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c.accent} paddingX={1} width={props.width} height={props.height}>
      <Text wrap="truncate-end">
        <Text color={c.accent} bold>output </Text>
        <Text color={c.fg}>{props.label}</Text>
        <Text color={c.dim}>  —  {data ? tildify(data.title) : "loading…"}</Text>
        {srcs.length > 0 && <Text color={c.dim}>   ←→ {srcs.length} more source{srcs.length > 1 ? "s" : ""}</Text>}
      </Text>
      <Text> </Text>
      {lines.map((l, i) => (
        <Text key={i} color={c.fg} wrap="truncate-end">{l || " "}</Text>
      ))}
    </Box>
  );
}

function HelpView(props: { width: number; height: number }) {
  const section = (title: string, keys: [string, string][]) => (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={c.magenta} bold>{title}</Text>
      {keys.map(([k, d]) => (
        <Text key={k}><Text color={c.accent}>{k.padEnd(12)}</Text><Text color={c.fg}>{d}</Text></Text>
      ))}
    </Box>
  );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c.accent} paddingX={2} width={props.width} height={props.height}>
      <Text color={c.accent} bold>keys</Text>
      <Text> </Text>
      <Box>
        <Box flexDirection="column" width={Math.floor((props.width - 6) / 2)}>
          {section("a job or one of its processes", [
            ["→ / ←", "show / hide the processes of a job"],
            ["o", "open its web page (↗ ports); a job with several: shows them"],
            ["f", "focus its terminal (tmux, Orca, Terminal, iTerm)"],
            ["p", "peek at its output (←→ terminal / conversation / logs)"],
            ["c", "copy `cd dir && command`"],
            ["x", "stop it (SIGTERM; again after 3s: kill -9)"],
            ["X", "force-kill now (kill -9)"],
          ])}
          {section("a job (Processes tab)", [
            ["space", "keep it"],
            ["R", "restart: stop, then run it again (same terminal if possible)"],
            ["a", "also show app & system servers (dimmed)"],
            ["s …", "sort: then t started, m memory, c CPU, n name, r reverse"],
          ])}
        </Box>
        <Box flexDirection="column">
          {section("Kept tab", [
            ["⏎ / R", "start: cd + put the command on your prompt (R restarts if running)"],
            ["t", "start in a new tmux window"],
            ["e", "edit"],
            ["d", "forget"],
          ])}
          {section("everywhere", [
            ["↑↓ jk g G", "move"],
            ["/", "filter"],
            ["tab", "switch tab"],
            ["r", "refresh now"],
            ["q", "quit"],
          ])}
        </Box>
      </Box>
      <Text color={c.dim}>
        Grouped by app, then by the directory each job was started in (⎇ git branch). A job's processes are listed
        under it; they can be opened, peeked at and stopped, but kept and restarted only as part of their job.
        <Text color={c.yellow}> ⤷ exited</Text>: the command finished but left these processes running.
        Agents (codex, claude, pi) show their conversation title; p → ←→ reads the conversation; R resumes it.
      </Text>
    </Box>
  );
}

function Empty({ mode, loading, filtered }: { mode: Mode; loading: boolean; filtered: boolean }) {
  const text = loading
    ? "scanning processes…"
    : filtered
      ? "nothing matches the filter — esc to clear"
      : mode === "kept"
        ? "nothing kept yet — in Processes, press space on a row to keep it"
        : "no relevant processes — press a to include app & system servers";
  return <Box paddingLeft={3} paddingTop={1}><Text color={c.dim}>{text}</Text></Box>;
}

function Footer(props: {
  width: number; mode: Mode; overlay?: Overlay["type"]; filtering: boolean; row?: Row; child?: Member; probes: Probes; open: boolean;
  confirm: Confirm | null; status: { text: string; tone: "ok" | "warn" | "err" } | null;
  sortMenu: { key: SortKey; desc: boolean } | null;
}) {
  if (props.sortMenu) {
    const cur = props.sortMenu;
    return (
      <Text wrap="truncate">
        <Text color={c.accent} bold> sort by: </Text>
        {(Object.keys(SORTS) as SortKey[]).map((k) => (
          <Text key={k}>
            <Text color={c.accent} bold> {SORTS[k].key}</Text>
            <Text color={k === cur.key ? c.fg : c.dim} bold={k === cur.key}> {SORTS[k].label}{k === cur.key ? " ✓" : ""} </Text>
          </Text>
        ))}
        <Text color={c.faint}>  ·  </Text>
        <Text color={c.accent} bold>r</Text>
        <Text color={c.dim}> reverse (now: {SORTS[cur.key].dirLabel[cur.desc ? 1 : 0]})</Text>
        <Text color={c.faint}>  ·  </Text>
        <Text color={c.accent}>esc</Text>
        <Text color={c.dim}> cancel</Text>
      </Text>
    );
  }
  if (props.confirm)
    return (
      <Text wrap="truncate">
        <Text color={c.red} bold> {props.confirm.text} </Text>
        <Text color={c.fg}>y</Text><Text color={c.dim}>/</Text><Text color={c.fg}>n</Text>
      </Text>
    );
  if (props.status) {
    const color = { ok: c.green, warn: c.yellow, err: c.red }[props.status.tone];
    return <Text color={color} wrap="truncate"> {props.status.text}</Text>;
  }
  const listen = props.child ? props.child.listen : props.row?.listen ?? [];
  const hasWeb = webPages(listen, props.probes).length > 0;
  const web = hasWeb ? ([["o", "open"]] as [string, string][]) : [];
  const tree: [string, string][] = props.child
    ? [["←", "back to job"]]
    : props.row?.members.length ? [[props.open ? "←" : "→", props.open ? "hide processes" : "processes"]] : [];
  const keys: [string, string][] =
    props.overlay === "keep" || props.overlay === "edit"
      ? [["⏎", "save"], ["tab ↑↓", "fields"], ["space", "toggle env"], ["esc", "cancel"]]
      : props.overlay === "peek"
        ? [["←→", "terminal / conversation / logs"], ["f", "focus terminal"], ["esc", "back"]]
        : props.overlay
          ? [["esc", "back"]]
          : props.filtering
            ? [["type", "to filter"], ["⏎", "done"], ["esc", "clear"]]
            : props.mode === "procs"
              ? props.child
                ? [...tree, ...web, ["p", "peek"], ["x/X", "stop/kill -9 this"], ["c", "copy"], ["/", "filter"], ["?", "more"]]
                : [...tree, ["space", "keep"], ...web, ["f", "focus"], ["p", "peek"], ["R", "restart"], ["x/X", "stop/kill -9"], ["s", "sort"], ["/", "filter"], ["tab", "kept"], ["?", "more"]]
              : [["⏎", "to prompt"], ["t", "tmux"], ["e", "edit"], ["d", "forget"], ...(props.row ? ([["R", "restart"], ["f", "focus"], ["x", "kill"]] as [string, string][]) : []), ["tab", "processes"], ["?", "more"]];
  return (
    <Text wrap="truncate">
      {keys.map(([k, label]) => (
        <Text key={k + label}>
          <Text color={c.accent}> {k}</Text>
          <Text color={c.dim}> {label} </Text>
        </Text>
      ))}
    </Text>
  );
}
