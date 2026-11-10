// An agent's session as a conversation: reads the end of its transcript (JSON lines written by
// Claude Code, Codex, pi…) and turns it into messages — what the person typed, what the agent
// answered, and the tools it ran — for the `conversation` node. Like running's transcriptTail,
// but structured and without cutting messages short.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Message } from "@toolbelt/sdk";

const MAX_BYTES = 2 * 1024 * 1024;

/** The last `limit` messages of a transcript. */
export function readConversation(file: string, harness: string, limit = 200): Message[] {
	let text: string;
	try {
		const size = statSync(file).size;
		const len = Math.min(size, MAX_BYTES);
		const buf = Buffer.alloc(len);
		const fd = openSync(file, "r");
		readSync(fd, buf, 0, len, size - len);
		closeSync(fd);
		text = buf.toString("utf8");
		if (len < size) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
	} catch {
		return [{ role: "system", text: "The transcript can't be read." }];
	}
	return parseConversation(text, harness).slice(-limit);
}

const textOf = (c: unknown): string =>
	typeof c === "string"
		? c
		: Array.isArray(c)
			? c
					.map((x: any) => (x?.type === "text" || x?.type === "input_text" || x?.type === "output_text" ? String(x.text ?? "") : ""))
					.filter(Boolean)
					.join("\n\n")
			: "";

const timeOf = (d: any): number | undefined => {
	const t = Date.parse(d?.timestamp ?? d?.payload?.timestamp ?? "");
	return Number.isFinite(t) ? t : undefined;
};

/** One line of a tool's input, for the compact row. */
function summarize(input: unknown): string {
	if (input === undefined || input === null) return "";
	if (typeof input === "string") return input.split("\n")[0].slice(0, 140);
	const o = input as Record<string, unknown>;
	const pick = o.command ?? o.cmd ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.description ?? o.prompt;
	if (typeof pick === "string") return pick.split("\n")[0].slice(0, 140);
	if (Array.isArray(pick)) return pick.join(" ").slice(0, 140);
	return JSON.stringify(input).slice(0, 140);
}

const detailOf = (input: unknown) => (input === undefined ? undefined : (typeof input === "string" ? input : JSON.stringify(input, null, 2)).slice(0, 4000));

/** Injected context, not something the person typed. */
const injected = (t: string) => !t.trim() || t.startsWith("<") || t.startsWith("# AGENTS.md") || t.startsWith("Caveat:");

export function parseConversation(text: string, harness: string): Message[] {
	const out: Message[] = [];
	const me = harness || "agent";
	const say = (role: "user" | "assistant", t: string, at?: number) => {
		const body = t.replace(/\r/g, "").trim();
		if (!body) return;
		if (role === "user" && injected(body)) return;
		out.push({ role, author: role === "user" ? "You" : me, text: body, at });
	};
	const tool = (name: string, input: unknown, at?: number) => out.push({ role: "tool", text: summarize(input), tool: { name, detail: detailOf(input) }, at });

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let d: any;
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}
		const at = timeOf(d);
		if (harness === "codex") {
			const p = d.payload ?? {};
			if (d.type === "response_item" && p.type === "message" && (p.role === "user" || p.role === "assistant")) say(p.role, textOf(p.content), at);
			else if (d.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call")) {
				let input: unknown = p.arguments ?? p.input ?? p.action;
				if (typeof input === "string") {
					try {
						input = JSON.parse(input);
					} catch {}
				}
				tool(p.name ?? p.type, input, at);
			}
		} else if (harness === "claude") {
			const m = d.message;
			if (d.isMeta || d.isSidechain) continue;
			if (d.type === "user" && m) {
				if (typeof m.content === "string") say("user", m.content, at);
				else if (Array.isArray(m.content) && m.content.every((p: any) => p?.type === "text")) say("user", textOf(m.content), at);
			}
			if (d.type === "assistant" && Array.isArray(m?.content)) {
				for (const part of m.content) {
					if (part.type === "text") say("assistant", part.text, at);
					if (part.type === "tool_use") tool(part.name, part.input, at);
				}
			}
		} else {
			const m = d.message;
			if (m?.role === "user") say("user", textOf(m.content), at);
			if (m?.role === "assistant") {
				say("assistant", textOf(m.content), at);
				for (const part of Array.isArray(m.content) ? m.content : []) if (part.type === "toolCall") tool(part.name, part.arguments, at);
			}
		}
	}
	return out;
}
