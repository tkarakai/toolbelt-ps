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
        // Probed as the ToolBelt version the pinned SDK matches (`HOST_VERSION`).
        return packagePlugin(
          "dist/package",
          "artifacts",
          undefined,
          await makeTerminalArchives(),
        );
      },
    },
  },
} satisfies ReleaseConfig;
