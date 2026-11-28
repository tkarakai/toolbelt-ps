// The plugin over protocol 3, end to end: src/index.ts runs as ToolBelt would start it, with a
// fake running-core (test/fixtures/fake-core), a temporary home and a temporary data folder.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Msg = { type: string; [k: string]: any };
const root = mkdtempSync(join(tmpdir(), "processes-views-"));
const data = join(root, "data");
const saved = { showAll: true, terminal: "terminal", filters: { agent: ["claude"] }, view: "flat" };
let proc: ReturnType<typeof Bun.spawn>;
const messages: Msg[] = [];
let seen = 0;
const send = (m: unknown) => {
	const sink = proc.stdin as import("bun").FileSink;
	sink.write(JSON.stringify(m) + "\n");
	sink.flush();
};
/** The first message after the last one waited for that matches. */
async function next(match: (m: Msg) => boolean, ms = 5000): Promise<Msg> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const i = messages.findIndex((m, at) => at >= seen && match(m));
		if (i >= 0) {
			seen = i + 1;
			return messages[i]!;
		}
		await Bun.sleep(10);
	}
	throw new Error(`timed out; got ${JSON.stringify(messages.slice(seen).map((m) => [m.type, m.surface, m.instance]))}`);
}
const rendered = (surface: string, instance: string, match: (tree: any) => boolean = () => true) =>
	next((m) => m.type === "render" && m.surface === surface && m.instance === instance && match(m.tree));
let events = 0;
const event = (surface: string, instance: string, name: string, payload?: unknown) => send({ type: "event", id: `e${++events}`, surface, instance, name, payload, origin: "person" });
const table = (tree: any) => tree.children.find((c: any) => c.type === "table");
const rowIds = (tree: any) => table(tree).rows.map((r: any) => r.id);
const control = (tree: any, id: string) => tree.controls.find((c: any) => c.id === id).value;
const filter = (tree: any, id: string) => tree.filters.find((f: any) => f.id === id).selected;
const prefsFile = () => JSON.parse(readFileSync(join(data, "prefs.json"), "utf8"));
const SCREEN = "screen:processes";

beforeAll(async () => {
	mkdirSync(join(root, "home"), { recursive: true });
	mkdirSync(data, { recursive: true });
	writeFileSync(join(data, "prefs.json"), JSON.stringify(saved));
	proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts")], {
		env: {
			PATH: process.env.PATH,
			HOME: join(root, "home"),
			T3CODE_HOME: join(root, "t3"),
			TOOLBELT_PLUGIN: "processes",
			TOOLBELT_PLUGIN_VERSION: "0.0.0-test",
			TOOLBELT_DATA_DIR: data,
			RUNNING_CORE_SCRIPT: join(import.meta.dir, "fixtures/fake-core/serve.ts"),
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	void (async () => {
		const decoder = new TextDecoder();
		let buf = "";
		for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
			buf += decoder.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line) messages.push(JSON.parse(line));
			}
		}
	})();
	send({ type: "hello", protocol: 3, capabilities: ["ui.core"] });
	await next((m) => m.type === "ready", 10000);
});
afterAll(async () => {
	send({ type: "shutdown" });
	(proc.stdin as import("bun").FileSink).end();
	await proc.exited;
	rmSync(root, { recursive: true, force: true });
});

describe("protocol 3 views", () => {
	test("hello declares the Processes view, starting from what people saved before", () => {
		const hello = messages.find((m) => m.type === "hello")!;
		expect(hello.protocol).toBe(3);
		expect(hello.declarations.views).toEqual({
			[SCREEN]: { search: true, filters: { agent: ["claude"], service: [] }, controls: { "process-scope": "services", "process-view": "flat" } },
		});
	});

	test("the person's screen opens with the saved choices as its view", async () => {
		send({ type: "open", surface: SCREEN, instance: "person" });
		const tree = (await rendered(SCREEN, "person")).tree;
		expect(control(tree, "process-scope")).toBe("services");
		expect(control(tree, "process-view")).toBe("flat");
		expect(filter(tree, "agent")).toEqual(["claude"]);
		expect(table(tree).id).toBe("processes-flat");
		expect(rowIds(tree)).toEqual(["102"]);
		expect(tree.search.query).toBe("");
	});

	test("search, filters and controls are applied by the SDK, reported to the host and not saved by Processes", async () => {
		event(SCREEN, "person", "filter", { filter: "agent", values: [] });
		expect((await next((m) => m.type === "view")).view).toEqual({ filters: { agent: [] } });
		expect(rowIds((await rendered(SCREEN, "person")).tree).sort()).toEqual(["101", "102", "103"]);

		event(SCREEN, "person", "search", { query: "bun run" });
		expect((await next((m) => m.type === "view")).view).toMatchObject({ search: "bun run" });
		let tree = (await rendered(SCREEN, "person")).tree;
		expect(tree.search.query).toBe("bun run");
		expect(rowIds(tree)).toEqual(["101"]);

		event(SCREEN, "person", "search", { query: "" });
		event(SCREEN, "person", "field", { form: "process-scope", field: "process-scope", value: "work" });
		await next((m) => m.type === "badge" && m.value === 2);
		tree = (await rendered(SCREEN, "person", (t) => control(t, "process-scope") === "work")).tree;
		expect(rowIds(tree).sort()).toEqual(["101", "102"]);

		event(SCREEN, "person", "field", { form: "process-view", field: "process-view", value: "grouped" });
		tree = (await rendered(SCREEN, "person", (t) => control(t, "process-view") === "grouped")).tree;
		expect(table(tree).id).toBe("processes");
		expect(prefsFile()).toEqual(saved);
	});

	test("an agent's instance renders on its own, from the defaults, and can be set by the host", async () => {
		send({ type: "open", surface: SCREEN, instance: "agent:test" });
		let tree = (await rendered(SCREEN, "agent:test")).tree;
		expect(control(tree, "process-scope")).toBe("services");
		expect(filter(tree, "agent")).toEqual(["claude"]);
		expect(rowIds(tree)).toEqual(["102"]);

		send({ type: "view", surface: SCREEN, instance: "agent:test", view: { search: "helper", filters: { agent: [] } } });
		expect((await next((m) => m.type === "view")).instance).toBe("agent:test");
		tree = (await rendered(SCREEN, "agent:test")).tree;
		expect(tree.search.query).toBe("helper");
		expect(rowIds(tree)).toEqual(["103"]);
		// The person's view is untouched, and so is the badge, which follows the person's scope.
		expect(messages.slice(seen).some((m) => m.type === "render" && m.instance === "person")).toBe(false);
		send({ type: "close", surface: SCREEN, instance: "agent:test" });
	});

	test("sort stays the plugin's: events reach it, the engine sorts and the plugin's own sort is saved", async () => {
		event(SCREEN, "person", "sort", { table: "processes", key: "cpu", desc: true });
		let tree = (await rendered(SCREEN, "person", (t) => table(t).sort?.key === "cpu")).tree;
		expect(table(tree).sort).toEqual({ key: "cpu", desc: true });
		event(SCREEN, "person", "sort", { table: "processes", key: "ports", desc: false });
		tree = (await rendered(SCREEN, "person", (t) => table(t).sort?.key === "ports")).tree;
		expect(prefsFile()).toEqual({ ...saved, flatSort: { key: "ports", desc: false } });
	});

	test("dialogs belong to the person's instance", async () => {
		send({ type: "open", surface: "screen:kept", instance: "person" });
		send({ type: "open", surface: "screen:kept", instance: "agent:test" });
		await rendered("screen:kept", "agent:test");
		event("screen:kept", "person", "add-kept");
		const tree = (await rendered("screen:kept", "person", (t) => !!t.dialog)).tree;
		expect(tree.dialog.id).toBe("keep");
		await Bun.sleep(100);
		const agent = messages.filter((m) => m.type === "render" && m.surface === "screen:kept" && m.instance === "agent:test");
		expect(agent.every((m) => !m.tree.dialog)).toBe(true);
	});
});
