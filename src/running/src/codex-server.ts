import { basename } from "node:path";

/** A shared Codex host, not its daemon maintenance commands or worker helpers. */
export function isCodexAppServer(argv: string[]): boolean {
  return basename(argv[0] ?? "") === "codex" && argv[1] === "app-server" && argv[2] !== "daemon";
}
