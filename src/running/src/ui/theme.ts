// One place for the look. Truecolor hex; tuned for dark terminals.
export const c = {
  fg: "#c0caf5",
  dim: "#565f89",
  faint: "#3b4261",
  accent: "#7aa2f7",
  accentFg: "#1a1b26",
  green: "#9ece6a",
  cyan: "#7dcfff",
  dimCyan: "#4c8aa8",
  muted: "#8a7fb0", // rows only visible in the "all" view: apps & system
  dirFg: "#89b4fa", // directory headers
  branch: "#73daca", // git branch
  childFg: "#a9b1d6", // processes inside a job
  yellow: "#e0af68",
  red: "#f7768e",
  magenta: "#bb9af7",
  selBg: "#292e42",
} as const;

export function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (h < 1) return `${m}m`;
  if (d < 1) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${d}d${h % 24}h`;
}

export function fmtMem(kb: number): string {
  const mb = kb / 1024;
  if (mb < 1000) return `${Math.round(mb)}M`;
  return `${(mb / 1024).toFixed(1)}G`;
}

export function fmtPorts(ports: number[], width: number): string {
  if (!ports.length) return "";
  let s = `:${ports[0]}`;
  for (let i = 1; i < ports.length; i++) {
    const next = `${s} :${ports[i]}`;
    const more = ` +${ports.length - i}`;
    if (next.length + (i < ports.length - 1 ? more.length : 0) > width) return s + more;
    s = next;
  }
  return s;
}

/** Fit to width: pad, or cut with an ellipsis (from the left for paths). */
export function fit(s: string, w: number, from: "right" | "left" = "right"): string {
  if (w <= 0) return "";
  if (s.length <= w) return s.padEnd(w);
  if (w === 1) return "…";
  return from === "right" ? s.slice(0, w - 1) + "…" : "…" + s.slice(s.length - w + 1);
}

export function ago(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return Number.isFinite(sec) ? fmtUptime(sec) + " ago" : iso;
}
