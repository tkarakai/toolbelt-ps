import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asString, typedLine } from "../../src/running/src/terminals.ts";

// The desktop app's engine: src/serve.ts over stdio, one JSON object per line.
const dir = mkdtempSync(join(tmpdir(), "running-serve-"));
const core = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/running/src/serve.ts")], {
  stdin: "pipe", stdout: "pipe", stderr: "ignore",
  env: { ...process.env, RUNNING_CONFIG_DIR: dir, RUNNING_LOG_FILE: join(dir, "commands.log") },
});
const waiting = new Map<number, (v: any) => void>();
(async () => {
  let buf = "";
  for await (const chunk of core.stdout) {
    buf += new TextDecoder().decode(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (!msg.event) waiting.get(msg.id)?.(msg);
    }
  }
})();
let next = 0;
const call = (method: string, params: object = {}) =>
  new Promise<any>((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    core.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    core.stdin.flush();
  });

// Something of ours to find: a listening server started by this test.
const server = Bun.serve({ port: 0, fetch: () => new Response("<title>t</title>", { headers: { "content-type": "text/html" } }) });

afterAll(() => {
  core.stdin.end();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("hello reports the version and where data lives", async () => {
  const { result } = await call("hello");
  expect(result.version).toBe(JSON.parse(readFileSync(join(import.meta.dir, "../../src/running/package.json"), "utf8")).version);
  expect(result.keptFile).toBe(join(dir, "kept.yaml"));
  expect(Object.keys(result.sorts)).toEqual(["started", "memory", "cpu", "name"]);
});

test("snapshot lists rows, kept entries, probes and the sort", async () => {
  const { result } = await call("snapshot");
  expect(Array.isArray(result.rows)).toBe(true);
  expect(result.kept).toEqual([]);
  expect(result.sort.key).toBeDefined();
  for (const r of result.rows) {
    expect(typeof r.pid).toBe("number");
    expect(Array.isArray(r.members)).toBe(true);
    expect(r.env).toBeUndefined(); // environments stay in the engine
  }
}, 20_000);

test("sort is saved where the TUI reads it", async () => {
  const { result } = await call("setSort", { key: "memory", desc: false });
  expect(result).toEqual({ key: "memory", desc: false });
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).sort).toEqual({ key: "memory", desc: false });
});

test("errors come back as messages, not crashes", async () => {
  expect((await call("nope")).error).toContain("unknown method");
  expect((await call("forget", { index: 5 })).error).toContain("gone");
  expect((await call("hello")).result.version).toBeDefined(); // still alive
});

test("copyLine quotes like the TUI", async () => {
  expect((await call("copyLine", { cwd: "/tmp/a b", command: "ls" })).result.line).toBe("cd '/tmp/a b' && ls");
});

test("typed lines and AppleScript strings are quoted safely", () => {
  expect(typedLine("/tmp/x", "bun dev")).toBe("cd /tmp/x && bun dev");
  expect(typedLine("", "ls")).toBe("ls");
  expect(asString(`say "hi" \\ bye`)).toBe(`"say \\"hi\\" \\\\ bye"`);
});
