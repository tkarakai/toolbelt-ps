import { expect, test } from "bun:test";
import { scopeControl, scopeValue } from "../src/scope";

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
