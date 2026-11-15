import { expect, test } from "bun:test";
import { scopeControl, scopeValue, viewControl, viewValue, withScope } from "../src/scope";

test("scope reflects existing saved preferences and explains its limits", () => {
 expect(scopeControl(false).value).toBe("work");
 expect(scopeControl(true).value).toBe("services");
 expect(scopeControl(false).options.map(o => o.label)).toEqual(["Your Work", "All services"]);
 expect(scopeControl(true).options[1]!.tooltip).toContain("does not include every process");
});
test("scope events set an explicit value and reject unrelated or malformed input", () => {
 const payload = { form: "process-scope", field: "process-scope", value: "work" };
 expect(scopeValue(payload)).toBe(false);
 expect(scopeValue({...payload, value:"services"})).toBe(true);
 for (const p of [undefined, {...payload, form:"keep"}, {...payload, field:"other"}, {...payload, value:true}, {...payload, value:"everything"}]) expect(scopeValue(p)).toBeUndefined();
});
test("layout toggle sits beside scope on Processes and validates its events", () => {
 const page = withScope({ type: "page", children: [] }, false, "flat");
 expect(page.controls?.map(c => c.id)).toEqual(["process-scope", "process-view"]);
 expect(withScope({ type: "page", children: [] }, false).controls?.map(c => c.id)).toEqual(["process-scope"]);
 expect(viewControl("grouped").value).toBe("grouped");
 const payload = { form: "process-view", field: "process-view", value: "flat" };
 expect(viewValue(payload)).toBe("flat");
 expect(viewValue({...payload, value:"grouped"})).toBe("grouped");
 for (const p of [undefined, {...payload, form:"process-scope"}, {...payload, value:"tree"}]) expect(viewValue(p)).toBeUndefined();
});
