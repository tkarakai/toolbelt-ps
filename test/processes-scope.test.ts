import { expect, test } from "bun:test";
import { resolveView } from "@toolbelt/sdk";
import { LAYOUT, SCOPE, processesView, readView, scopeControl, viewControl, withScope } from "../src/scope";

test("scope reflects existing saved preferences and explains its limits", () => {
 expect(scopeControl(false).value).toBe("work");
 expect(scopeControl(true).value).toBe("services");
 expect(scopeControl(false).options.map(o => o.label)).toEqual(["Your Work", "All services"]);
 expect(scopeControl(true).options[1]!.tooltip).toContain("does not include every process");
});
test("layout toggle sits beside scope on Processes", () => {
 const page = withScope({ type: "page", children: [] }, false, "flat");
 expect(page.controls?.map(c => c.id)).toEqual([SCOPE, LAYOUT]);
 expect(withScope({ type: "page", children: [] }, false).controls?.map(c => c.id)).toEqual([SCOPE]);
 expect(viewControl("grouped").value).toBe("grouped");
});
test("the view declares search, both filters and both controls, starting from saved choices", () => {
 expect(processesView({})).toEqual({ search: true, filters: { agent: [], service: [] }, controls: { [SCOPE]: "work", [LAYOUT]: "grouped" } });
 expect(processesView({ showAll: true, view: "flat", filters: { agent: ["claude"], service: ["listening"] } })).toEqual({
  search: true, filters: { agent: ["claude"], service: ["listening"] }, controls: { [SCOPE]: "services", [LAYOUT]: "flat" },
 });
 // Sort stays the plugin's: running sorts one list for everyone.
 expect(processesView({}).sort).toBeUndefined();
});
test("a view reads as query, filters, scope and layout; unknown control values fall back", () => {
 const declared = processesView({ showAll: true, view: "flat", filters: { agent: ["codex"] } });
 expect(readView(resolveView(declared, {}, "person"))).toEqual({ query: "", filters: { agent: ["codex"], service: [] }, showAll: true, layout: "flat" });
 const chosen = resolveView(declared, { search: "vite", filters: { agent: [] }, controls: { [SCOPE]: "work", [LAYOUT]: "grouped" } }, "person");
 expect(readView(chosen)).toEqual({ query: "vite", filters: { agent: [], service: [] }, showAll: false, layout: "grouped" });
 expect(readView(resolveView(declared, { controls: { [SCOPE]: "everything", [LAYOUT]: "tree" } }, "agent:x"))).toMatchObject({ showAll: false, layout: "grouped" });
});
