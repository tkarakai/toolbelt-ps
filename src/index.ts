// The package's entry: the Processes plugin (src/plugin.ts) over ToolBelt's stdio transport.
import { definePlugin } from "@toolbelt/sdk";
import { definition } from "./plugin";

definePlugin(definition);
