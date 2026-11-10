import { expect, test } from "bun:test";
import { explains, inferScript } from "../../src/running/src/procs.ts";

const bunEnv = {
  npm_lifecycle_event: "dev",
  npm_execpath: "/Users/me/.bun/bin/bun",
  npm_config_user_agent: "bun/1.4.4 npm/? node/v26.3.0 darwin arm64",
  npm_config_local_prefix: "/Users/me/app",
};

test("package script is reconstructed from the environment, not the latest history line", () => {
  // `claude` was typed in another terminal after `bun dev`, before its children started.
  const history = ["claude", "bun dev", "bun dev:stop"];
  expect(inferScript([{}, bunEnv], history)).toEqual({ command: "bun dev", dir: "/Users/me/app" });
});

test("canonical spelling when history has no matching line", () => {
  expect(inferScript([bunEnv], ["claude"])?.command).toBe("bun run dev");
  const npm = { npm_lifecycle_event: "start", npm_execpath: "/x/npm-cli.js", npm_config_local_prefix: "/a" };
  expect(inferScript([npm], [])?.command).toBe("npm start");
  const pnpm = { npm_lifecycle_event: "dev", npm_config_user_agent: "pnpm/9.0.0 npm/? node/v22" };
  expect(inferScript([pnpm], [])?.command).toBe("pnpm dev");
});

test("history spelling keeps extra arguments but must match the script", () => {
  expect(inferScript([bunEnv], ["bun run dev --app=web"])?.command).toBe("bun run dev --app=web");
  expect(inferScript([bunEnv], ["bun dev:stop"])?.command).toBe("bun run dev"); // dev:stop ≠ dev
});

test("no package variables → no inference", () => {
  expect(inferScript([{ PATH: "/bin" }], ["bun dev"])).toBeUndefined();
});

test("a history line only explains processes whose program it names", () => {
  const members = [["python3", "-m", "http.server"], ["node", "/x/next"]];
  expect(explains("claude", members)).toBe(false);
  expect(explains("PORT=1 python3 -m http.server 8000", members)).toBe(true);
  expect(explains("cd /tmp", members)).toBe(false);
});
