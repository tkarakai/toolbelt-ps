// CMUX navigation is a public URL route; it doesn't require socket automation access.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function cmuxLink(workspace?: string, surface?: string): string | undefined {
    if (!workspace || !surface || !uuid.test(workspace) || !uuid.test(surface)) return;
    return `cmux://workspace/${workspace}/surface/${surface}`;
}
export type CmuxLocation = { workspace: string; surface: string };
/** CMUX's latest saved layout is advisory; match exact surface identity, never directory. */
export function cmuxLocations(snapshot: unknown): Map<string, CmuxLocation> {
    const out = new Map<string, CmuxLocation>();
    const root = snapshot as any;
    for (const window of Array.isArray(root?.windows) ? root.windows : []) {
        for (const workspace of Array.isArray(window?.tabManager?.workspaces) ? window.tabManager.workspaces : []) {
            for (const panel of Array.isArray(workspace?.panels) ? workspace.panels : []) {
                if (typeof panel?.id !== "string" || !uuid.test(panel.id)) continue;
                out.set(panel.id.toLowerCase(), {
                    workspace: workspace.customTitle || workspace.processTitle || workspace.workspaceId || "CMUX workspace",
                    surface: panel.customTitle || panel.title || panel.id,
                });
            }
        }
    }
    return out;
}
let checked = 0, stamp = -1, cached = new Map<string, CmuxLocation>();
export function readCmuxLocations(): Map<string, CmuxLocation> {
    if (Date.now() - checked < 2000) return cached;
    checked = Date.now();
    try {
        const path = join(homedir(), "Library/Application Support/cmux/session-com.cmuxterm.app.json");
        const mtime = statSync(path).mtimeMs;
        if (mtime !== stamp) { cached = cmuxLocations(JSON.parse(readFileSync(path, "utf8"))); stamp = mtime; }
    } catch { cached = new Map(); stamp = -1; }
    return cached;
}
