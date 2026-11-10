import {describe,test,expect} from "bun:test";
import {parseConversation} from "../src/conversation";
describe("parseConversation", () => {
	test("Claude Code: typed messages, answers and tool calls; injected context skipped", () => {
		const lines = [
			{ type: "user", timestamp: "2026-11-09T10:00:00Z", message: { role: "user", content: "fix the build" } },
			{ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
			{ type: "assistant", message: { content: [{ type: "text", text: "On it." }, { type: "tool_use", name: "Bash", input: { command: "bun test\nmore" } }] } },
			{ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
		].map((l) => JSON.stringify(l));
		const m = parseConversation(lines.join("\n") + "\nnot json", "claude");
		expect(m.map((x) => [x.role, x.text])).toEqual([
			["user", "fix the build"],
			["assistant", "On it."],
			["tool", "bun test"],
		]);
		expect(m[0].at).toBe(Date.parse("2026-11-09T10:00:00Z"));
		expect(m[1].author).toBe("claude");
		expect(m[2].tool?.name).toBe("Bash");
	});
	test("Codex", () => {
		const lines = [
			{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md stuff" }] } },
			{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
			{ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["ls", "-la"] }) } },
			{ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
		].map((l) => JSON.stringify(l));
		expect(parseConversation(lines.join("\n"), "codex").map((x) => [x.role, x.text])).toEqual([
			["user", "hello"],
			["tool", "ls -la"],
			["assistant", "Done."],
		]);
	});
});
