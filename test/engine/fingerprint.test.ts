import { expect, test } from "bun:test";
import { argsCover, parseCommand, sameCommand, sessionIds, shellWords } from "../../src/running/src/fingerprint.ts";

const ORCA_CODEX = [
  "/Users/me/.nvm/versions/node/v24/lib/node_modules/@openai/codex/vendor/bin/codex",
  "--no-daemon", "-c", "shell_environment_policy.set.ORCA_USER_DATA_PATH='/Users/me/Library/Application Support/orca'",
  "-c", "disable_paste_burst=true", "resume", "01a1567f-ff22-7a91-a59d-bb0fbf8c6719",
];

test("kept `codex resume <id>` matches codex launched by Orca with extra -c flags", () => {
  expect(sameCommand("codex resume 01a1567f-ff22-7a91-a59d-bb0fbf8c6719", ORCA_CODEX)).toBe(true);
});

test("…but not another session, or a different subcommand", () => {
  expect(sameCommand("codex resume 01a1567f-0000-0000-0000-000000000000", ORCA_CODEX)).toBe(false);
  expect(sameCommand("codex exec hello", ORCA_CODEX)).toBe(false);
  expect(sameCommand("codex", ORCA_CODEX)).toBe(false); // the running one has an extra positional: resume <id>
});

test("package runner spellings", () => {
  expect(sameCommand("bun dev", "bun run dev")).toBe(true);
  expect(sameCommand("bun run dev", "bun dev")).toBe(true);
  expect(sameCommand("bun dev", "bun dev:stop")).toBe(false);
  expect(sameCommand("npm run dev", "pnpm dev")).toBe(false);
});

test("env prefixes: kept values must not contradict the running command", () => {
  expect(sameCommand("PORT_X=1 ./start.sh", "PORT_X=1 ./start.sh")).toBe(true);
  expect(sameCommand("PORT_X=1 ./start.sh", "./start.sh")).toBe(true);
  expect(sameCommand("PORT_X=1 ./start.sh", "PORT_X=2 ./start.sh")).toBe(false);
});

test("full paths vs names; option values are not mistaken for positionals", () => {
  expect(sameCommand("python3 -m http.server 8765", ["/usr/local/bin/python3", "-m", "http.server", "8765"])).toBe(true);
  expect(sameCommand("python3 -m http.server 8765", "python3 -m http.server 8766")).toBe(false);
  expect(argsCover(["--port", "3000", "serve"], ["serve"])).toBe(true);
});

test("shell words and session ids", () => {
  expect(shellWords(`a 'b c' "d \\"e\\"" f\\ g`)).toEqual(["a", "b c", 'd "e"', "f g"]);
  expect(parseCommand("FOO=1 BAR='x y' /bin/tool run x").env).toEqual({ FOO: "1", BAR: "x y" });
  expect([...sessionIds("claude --resume 8B52D472-1EDF-448B-9A7E-14D80FDFA58D")]).toEqual(["8b52d472-1edf-448b-9a7e-14d80fdfa58d"]);
});

test("app sandbox containers are never resolved (macOS can block on them)", () => {
  const { sameDir, isAppContainer } = require("../../src/running/src/fingerprint.ts");
  const c = "/Users/me/Library/Containers/io.tailscale.ipn.macos.network-extension/Data";
  expect(isAppContainer(c)).toBe(true);
  expect(isAppContainer("/Users/me/Library/Group Containers/x/y")).toBe(true);
  expect(isAppContainer("/Users/me/dev/app")).toBe(false);
  expect(sameDir(c, c)).toBe(true);
  expect(sameDir("/tmp", c)).toBe(false);
});
