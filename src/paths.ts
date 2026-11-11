// Resolve only this package's owned payload (or its local development source).
import { existsSync } from "node:fs";
import { join } from "node:path";

export const pluginDir = import.meta.dir;

const first = (...paths: string[]) => paths.find((p) => existsSync(p)) ?? paths[paths.length - 1]!;

export function coreScript(dir = pluginDir, env: Record<string, string | undefined> = process.env) {
	return env.RUNNING_CORE_SCRIPT || first(join(dir, "payload/running-core.js"), join(dir, "running/src/serve.ts"));
}

export function tuiScript(dir = pluginDir) {
	return first(join(dir, "payload/bin/running"), join(dir, "running/src/main.tsx"));
}
