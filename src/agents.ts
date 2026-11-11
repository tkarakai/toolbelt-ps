// Known AI coding agents (CLI harnesses), how to recognize their processes, and the color each
// one gets in the table. running-core itself knows three in depth (claude, codex, pi: sessions,
// titles, busy/idle); the rest are recognized from the command line only.
//
// A process is an agent when its program — or, for Node/Python/Bun-run CLIs, the script it
// runs — is one of `bins`, or its command line contains one of `packages` (an npm/pip package
// path, e.g. …/node_modules/@google/gemini-cli/…). Names checked against each project's docs
// and README, November 2026.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hue } from "@toolbelt/sdk";

export type AgentKind = { id: string; name: string; hue: Hue; bins: string[]; packages?: string[] };

export const AGENTS: AgentKind[] = [
	{ id: "claude", name: "Claude Code", hue: "amber", bins: ["claude"], packages: ["@anthropic-ai/claude-code"] },
	{ id: "codex", name: "Codex", hue: "blue", bins: ["codex"], packages: ["@openai/codex"] },
	{ id: "gemini", name: "Gemini CLI", hue: "sky", bins: ["gemini"], packages: ["@google/gemini-cli"] },
	{ id: "copilot", name: "Copilot CLI", hue: "violet", bins: ["copilot"], packages: ["@github/copilot"] },
	{ id: "cursor", name: "Cursor CLI", hue: "stone", bins: ["cursor-agent"] },
	{ id: "opencode", name: "OpenCode", hue: "teal", bins: ["opencode"], packages: ["opencode-ai"] },
	{ id: "amp", name: "Amp", hue: "rose", bins: ["amp"], packages: ["@sourcegraph/amp"] },
	{ id: "aider", name: "Aider", hue: "lime", bins: ["aider"], packages: ["aider-chat", "/aider/"] },
	{ id: "goose", name: "Goose", hue: "yellow", bins: ["goose"] },
	{ id: "qwen", name: "Qwen Code", hue: "indigo", bins: ["qwen"], packages: ["@qwen-code/qwen-code"] },
	{ id: "crush", name: "Crush", hue: "fuchsia", bins: ["crush"], packages: ["@charmland/crush"] },
	{ id: "kiro", name: "Kiro CLI", hue: "purple", bins: ["kiro-cli", "kiro-cli-chat"] },
	{ id: "q", name: "Amazon Q", hue: "sky", bins: ["q", "qchat"] },
	{ id: "droid", name: "Droid", hue: "amber", bins: ["droid"] },
	{ id: "pi", name: "Pi", hue: "cyan", bins: ["pi"], packages: ["@mariozechner/pi-coding-agent"] },
	{ id: "cline", name: "Cline", hue: "emerald", bins: ["cline"], packages: ["@cline/cli"] },
	{ id: "kilo", name: "Kilo Code", hue: "yellow", bins: ["kilocode", "kilo"], packages: ["@kilocode/cli"] },
	{ id: "auggie", name: "Auggie", hue: "green", bins: ["auggie"], packages: ["@augmentcode/auggie"] },
	{ id: "vibe", name: "Mistral Vibe", hue: "orange", bins: ["vibe"], packages: ["mistral-vibe", "mistral_vibe"] },
	{ id: "grok", name: "Grok CLI", hue: "stone", bins: ["grok"], packages: ["@vibe-kit/grok-cli"] },
	{ id: "openhands", name: "OpenHands", hue: "pink", bins: ["openhands"] },
	{ id: "plandex", name: "Plandex", hue: "teal", bins: ["plandex", "pdx"] },
];

const BY_BIN = new Map(AGENTS.flatMap((a) => a.bins.map((b) => [b, a] as const)));
/** Programs that run another program: the agent is the script after them. */
const RUNNERS = new Set(["node", "bun", "deno", "python", "python3", "uv", "uvx", "pipx", "npx", "bunx", "pnpm", "yarn", "env"]);
const base = (p: string) => p.split("/").pop() ?? p;

/** Which agent a process is, from its command line (and executable path), if any. */
export function detectAgent(argv: string[], exe?: string): AgentKind | undefined {
	let i = 0;
	while (i < argv.length && RUNNERS.has(base(argv[i]).replace(/\d+(\.\d+)*$/, ""))) {
		i++;
		while (i < argv.length && argv[i].startsWith("-")) i++; // node --flags script
	}
	const prog = argv[i] ? base(argv[i]).replace(/\.(m?js|cjs|ts|py)$/, "") : undefined;
	const byProg = prog ? BY_BIN.get(prog) : undefined;
	if (byProg) return byProg;
	const line = argv.slice(0, i + 1).join(" ");
	const byPackage = AGENTS.find((a) => a.packages?.some((p) => line.includes(p)));
	if (byPackage) return byPackage;
	return exe ? BY_BIN.get(base(exe)) : undefined;
}

export const agentById = (id: string) => AGENTS.find((a) => a.id === id);

/**
 * Claude Code says when it's waiting for you (a permission prompt, a question): its live
 * session file's `status` is "waiting" or "blocked" (running-core folds those into idle).
 */
export function claudeWaiting(pid: number, home = homedir()): boolean {
	try {
		const s = JSON.parse(readFileSync(join(home, ".claude", "sessions", `${pid}.json`), "utf8"));
		return s?.status === "waiting" || s?.status === "blocked";
	} catch {
		return false;
	}
}
