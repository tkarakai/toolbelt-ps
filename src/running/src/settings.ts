// Small UI preferences remembered between runs (~/.config/running/settings.json).
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export type SortKey = "started" | "memory" | "cpu" | "name";

interface SortSpec {
  label: string;
  key: string; // the key that picks it in the sort menu (after `s`)
  desc: boolean; // natural direction when first selected
  dirLabel: [asc: string, desc: string];
  /** How groups (apps, directories) are ordered: by total, by their biggest job, or by name. */
  group: "sum" | "max" | "label";
  value: (x: { rss: number; cpu: number; age: number; name: string }) => number | string;
}

export const SORTS: Record<SortKey, SortSpec> = {
  // `age` is seconds since start: ascending age = newest first, so "oldest first" is descending.
  started: { label: "started", key: "t", desc: true, dirLabel: ["newest first", "oldest first"], group: "label", value: (x) => x.age },
  memory: { label: "memory", key: "m", desc: true, dirLabel: ["smallest first", "largest first"], group: "sum", value: (x) => x.rss },
  cpu: { label: "CPU", key: "c", desc: true, dirLabel: ["idlest first", "busiest first"], group: "sum", value: (x) => x.cpu },
  name: { label: "name", key: "n", desc: false, dirLabel: ["A → Z", "Z → A"], group: "label", value: (x) => x.name.toLowerCase() },
};

export interface Settings {
  sort: { key: SortKey; desc: boolean };
}

const DIR = process.env.RUNNING_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "running");
const FILE = join(DIR, "settings.json");
const DEFAULTS: Settings = { sort: { key: "started", desc: true } };

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Settings>;
    const sort = s.sort && s.sort.key in SORTS ? s.sort : DEFAULTS.sort;
    return { sort };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(s, null, 2) + "\n");
  } catch {}
}
