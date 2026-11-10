#!/usr/bin/env bun
import { render } from "ink";
import { writeSync } from "node:fs";
import { App, type ExitAction } from "./ui/App.tsx";
import { KEPT_FILE } from "./store.ts";
import { LOG_FILE, SHELL_INIT } from "./hook.ts";
import pkg from "../package.json" with { type: "json" };

// Set by scripts/build.ts. The bundle runs on whatever Bun is installed; it's only tested
// with the one it was built with. (The standalone binary carries its own, so they always match.)
declare const __BUILT_WITH_BUN__: string | undefined;
const BUILT_WITH = typeof __BUILT_WITH_BUN__ === "string" ? __BUILT_WITH_BUN__ : undefined;
const bunMismatch = BUILT_WITH && BUILT_WITH !== Bun.version
  ? `running ${pkg.version} was built and tested with Bun ${BUILT_WITH}; you have Bun ${Bun.version}. ` +
    `It usually works, but isn't guaranteed — if it misbehaves, use the standalone build.`
  : null;


const arg = process.argv[2];
if (arg === "--init" || arg === "init") {
  process.stdout.write(SHELL_INIT);
  process.exit(0);
}
if (arg === "--version" || arg === "-v") {
  console.log(pkg.version);
  if (bunMismatch) console.error(bunMismatch);
  process.exit(0);
}
if (arg === "--help" || arg === "-h") {
  console.log(`running ${pkg.version} — see what's running, keep what matters, start it again.

  running            open the TUI
  running init       print the zsh setup (add  eval "$(command running init)"  to ~/.zshrc)

Kept processes: ${KEPT_FILE}
Command log:    ${LOG_FILE}
Bun:            ${BUILT_WITH ? `built with ${BUILT_WITH}, ` : ""}running on ${Bun.version}`);
  if (bunMismatch) console.error(`\n${bunMismatch}`);
  process.exit(0);
}
if (!process.stdout.isTTY) {
  console.error("running: needs an interactive terminal");
  process.exit(1);
}

// Alternate screen, like vim/htop: your scrollback is untouched on exit.
// Synchronous writes: leaving the alternate screen must happen before anything we print after it.
let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  writeSync(1, "\x1b[?25h\x1b[?1049l");
};
writeSync(1, "\x1b[?1049h\x1b[H\x1b[?25l");
process.on("exit", restore);

let action: ExitAction = {};
const app = render(<App onExit={(a) => (action = a)} />, { exitOnCtrlC: false, incrementalRendering: false, maxFps: 30 });
await app.waitUntilExit();
restore();
if (action.print) {
  // writeSync: process.exit would otherwise drop buffered output.
  writeSync(1, `\n  ${action.print}\n\n  ${action.copied ? "Copied to the clipboard. " : ""}The \`running\` shell function isn't loaded in this terminal,\n  so it can't be put on your prompt: open a new terminal or run \`exec zsh\`\n  (~/.zshrc needs: eval "$(command running init)").\n\n`);
}
process.exit(0);
