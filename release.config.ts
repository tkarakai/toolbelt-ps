import {
  json,
  packagePlugin,
  run,
  updateJSONVersion,
  type ReleaseConfig,
} from "@toolbelt/sdk/release";
import { makeTerminalArchives } from "./scripts/make-terminal-archives";
export default {
  repo: "tkarakai/toolbelt-ps",
  hostVersion: "0.1.0",
  products: {
    plugin: {
      changelog: "CHANGELOG.md",
      version: () => json("toolbelt.json").version,
      async setVersion(v) {
        await updateJSONVersion("package.json", v);
        await updateJSONVersion("toolbelt.json", v);
      },
      async build() {
        await run(["bun", "scripts/build.ts"]);
        return packagePlugin(
          "dist/package",
          "artifacts",
          "0.1.0",
          await makeTerminalArchives(),
        );
      },
    },
  },
} satisfies ReleaseConfig;
