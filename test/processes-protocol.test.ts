// Protocol 3 through the SDK's fake host, which checks what ToolBelt checks: every message is
// valid and every render uses only declared action and form ids. The plugin runs in this process
// against the fake running-core (test/fixtures/fake-core), a temporary home and data folder, so
// no real process is looked at, started or stopped. Actions that reach terminals (restart, jump,
// start) are never sent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHost } from "@toolbelt/sdk/testing";

const root = mkdtempSync(join(tmpdir(), "processes-protocol-"));
const env = {
	HOME: join(root, "home"),
	TOOLBELT_PS_HOME: join(root, "home"),
	T3CODE_HOME: join(root, "t3"),
	TOOLBELT_DATA_DIR: join(root, "data"),
	RUNNING_CORE_SCRIPT: join(import.meta.dir, "fixtures/fake-core/serve.ts"),
};
const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
let host: ReturnType<typeof fakeHost>;
const SCREENS = ["screen:processes", "screen:kept", "screen:settings", "quick"];
const AGENT = "agent:test";

beforeAll(async () => {
	for (const dir of [env.HOME, env.TOOLBELT_DATA_DIR]) mkdirSync(dir, { recursive: true });
	Object.assign(process.env, env);
	// The plugin reads its environment when it loads.
	const { definition } = await import("../src/plugin");
	host = fakeHost(definition);
	await host.hello();
	for (const surface of SCREENS) await host.open(surface);
	// The first snapshot arrives after the first render.
	for (let i = 0; i < 100 && !rowsOf("screen:processes").length; i++) await Bun.sleep(20);
});

afterAll(async () => {
	host.send({ type: "shutdown" });
	await host.idle();
	host.close();
	for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
	rmSync(root, { recursive: true, force: true });
});

const tree = (surface: string, instance?: string) => host.tree(surface, instance) as any;
const table = (surface: string, instance?: string) => tree(surface, instance)?.children?.find((c: any) => c.type === "table");
function rowsOf(surface: string): any[] {
	const all: any[] = [];
	const walk = (rows: any[] = []) => rows.forEach((r) => (all.push(r), walk(r.children)));
	walk(table(surface)?.rows);
	return all;
}

describe("declarations", () => {
	test("the manifest's surfaces render with only declared ids, and every message is valid", () => {
		for (const surface of SCREENS) expect(tree(surface)).toBeDefined();
		expect(rowsOf("screen:processes").map((r) => r.id)).toContain("101");
		expect(rowsOf("screen:kept").map((r) => r.id)).toEqual(["0"]);
		expect(host.rejected).toEqual([]);
		expect(host.invalid).toEqual([]);
	});

	test("each action says what it does", () => {
		const effect = (id: string) => host.declarations.actions[id]?.effect;
		for (const id of ["restart", "start", "start-in", "focus", "focus-kept", "open", "t3-open", "reveal-kept", "tui-install"]) expect(effect(id)).toBe("external");
		for (const id of ["stop", "kill", "forget", "tui-remove"]) expect(effect(id)).toBe("destructive");
		for (const id of ["keep-save", "up", "down", "undo-forget"]) expect(effect(id)).toBe("write");
		for (const id of ["output", "why", "keep", "edit", "edit-kept", "copy", "add-kept", "output-copy", "tui-check", "copy-init"]) expect(effect(id)).toBe("view");
		expect(host.declarations.forms).toEqual({ keep: { effect: "view" }, "output-source": { effect: "view" }, settings: { effect: "write" } });
	});
});

describe("events and results", () => {
	test("copying a row's command line tags the clipboard text and toast with the event", async () => {
		const r = await host.event("screen:processes", "copy", { rowId: "101" });
		expect(r).toMatchObject({ handled: true });
		expect(r.clipboard).toEqual(["cd /w/web && bun run dev"]);
		expect(r.toasts.map((t) => t.text)).toEqual(["Copied — paste it in a terminal"]);
	});

	test("Peek opens a dialog the fake host accepts, and Copy all and closing it are handled", async () => {
		expect(await host.event("screen:processes", "output", { rowId: "101" })).toMatchObject({ handled: true });
		expect(tree("screen:processes").dialog?.id).toBe("output");
		expect(host.rejected).toEqual([]);
		expect((await host.event("screen:processes", "output-copy", { dialog: "output" })).toasts.map((t) => t.text)).toEqual(["Output copied"]);
		expect(await host.event("screen:processes", "dialog-close", { dialog: "output" })).toMatchObject({ handled: true });
		expect(tree("screen:processes").dialog).toBeUndefined();
	});

	test("Keep… edits a draft and Keep saves it", async () => {
		await host.event("screen:processes", "keep", { rowId: "101" });
		expect(tree("screen:processes").dialog?.id).toBe("keep");
		expect(await host.event("screen:processes", "field", { form: "keep", field: "name", value: "web" })).toMatchObject({ handled: true });
		const r = await host.event("screen:processes", "keep-save", { dialog: "keep" });
		expect(r).toMatchObject({ handled: true });
		expect(r.toasts.map((t) => t.text)).toEqual(["Kept"]);
		expect(tree("screen:processes").dialog).toBeUndefined();
	});

	test("Forget offers Undo, a declared toast action that puts the command back", async () => {
		const r = await host.event("screen:kept", "forget", { rowId: "0" });
		expect(r.toasts[0]).toMatchObject({ text: "Forgot “web”", action: { id: "undo-forget" } });
		const undo = await host.event("toast", "undo-forget", r.toasts[0]!.action!.payload);
		expect(undo).toMatchObject({ handled: true });
		expect(undo.toasts.map((t) => t.text)).toEqual(["Restored “web”"]);
	});

	test("stopping a fake job is handled; a row that's gone, or an unknown event, isn't", async () => {
		expect((await host.event("screen:processes", "stop", { rowId: "101" })).toasts.map((t) => t.text)).toEqual(["Stopped bun run dev"]);
		expect(await host.event("screen:processes", "stop", { rowId: "999" })).toMatchObject({ handled: false });
		expect(await host.event("screen:kept", "forget", { rowId: "7" })).toMatchObject({ handled: false });
		expect(await host.event("screen:processes", "nonsense")).toMatchObject({ handled: false });
	});

	test("the plugin's own sort and the default terminal are handled", async () => {
		expect(await host.event("screen:processes", "sort", { table: "processes", key: "cpu", desc: true })).toMatchObject({ handled: true });
		expect(await host.event("screen:settings", "field", { form: "settings", field: "terminal", value: "terminal" })).toMatchObject({ handled: true });
		expect(await host.event("screen:settings", "field", { form: "settings", field: "terminal", value: "no-such-terminal" })).toMatchObject({ handled: false });
	});
});

describe("instances", () => {
	test("dialogs are the person's: an agent instance can't open one, and closing it leaves the person's", async () => {
		await host.open("screen:kept", AGENT);
		expect(await host.event("screen:kept", "add-kept", undefined, { instance: AGENT, origin: "agent" })).toMatchObject({ handled: false });
		expect(tree("screen:kept").dialog).toBeUndefined();

		await host.event("screen:kept", "add-kept");
		expect(tree("screen:kept").dialog?.id).toBe("keep");
		expect(tree("screen:kept", AGENT).dialog).toBeUndefined();
		await host.closeInstance("screen:kept", AGENT);
		expect(host.context.open.has("screen:kept")).toBe(true);
		host.context.invalidate();
		await host.idle();
		expect(tree("screen:kept").dialog?.id).toBe("keep");

		// Closing the person's screen closes its dialog.
		await host.closeInstance("screen:kept");
		await host.open("screen:kept");
		expect(tree("screen:kept").dialog).toBeUndefined();
		expect(host.rejected).toEqual([]);
	});
});
