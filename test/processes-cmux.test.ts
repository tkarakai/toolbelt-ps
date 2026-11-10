import { expect, test } from "bun:test";
import { cmuxLink, cmuxLocations } from "../src/cmux";
const workspace = "05C8458F-6632-48AD-943D-D177809F5F5A";
const surface = "F6D145EE-DCB9-41DF-B647-CE4E37213F86";
test("CMUX navigation uses exact UUID identity, without socket access or shell interpolation", () => {
    expect(cmuxLink(workspace, surface)).toBe(`cmux://workspace/${workspace}/surface/${surface}`);
    expect(cmuxLink(workspace, "surface:1")).toBeUndefined();
    expect(cmuxLink(workspace, "x/../../other")).toBeUndefined();
    expect(cmuxLink(undefined, surface)).toBeUndefined();
});
test("CMUX location matches surface identity even when workspace name differs from the process directory", () => {
    const locations = cmuxLocations({ windows: [{ tabManager: { workspaces: [{ workspaceId: workspace, customTitle: "web-app-starter", currentDirectory: "/projects/compass", panels: [{ id: surface, title: "Dependency upgrades" }] }] } }] });
    expect(locations.get(surface.toLowerCase())).toEqual({ workspace: "web-app-starter", surface: "Dependency upgrades" });
    expect(locations.get(workspace.toLowerCase())).toBeUndefined();
    expect(cmuxLocations(null).size).toBe(0);
    expect(cmuxLocations({windows:[{tabManager:{workspaces:[{panels:[null,{}]}]}}]}).size).toBe(0);
});
