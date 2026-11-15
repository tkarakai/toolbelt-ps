import type { Node } from "@toolbelt/sdk";
import type { View } from "./model";

export function scopeControl(showAll: boolean): Extract<Node, { type: "segmented" }> {
	return {
		type: "segmented" as const,
		id: "process-scope",
		label: "Process scope",
		value: showAll ? "services" : "work",
		options: [
			{ value: "work", label: "Your Work", tooltip: "Terminal jobs, dev servers, detached user commands and recognized coding agents — including agents launched by desktop apps." },
			{ value: "services", label: "All services", tooltip: "Everything in Your Work, plus app and system processes with listening ports. This does not include every process on your Mac." },
		],
	};
}

/** Grouped under where-it-runs and folder headers, or one flat list with those as columns. */
export function viewControl(view: View): Extract<Node, { type: "segmented" }> {
	return {
		type: "segmented" as const,
		id: "process-view",
		label: "Table layout",
		value: view,
		options: [
			{ value: "grouped", label: "Grouped", icon: "list-tree", tooltip: "Under headers for where each command runs and its folder and branch." },
			{ value: "flat", label: "Flat", icon: "rows-3", tooltip: "One list with App, Folder and Branch columns. Sort or reorder them like any column." },
		],
	};
}

/** Keep the scope (and, on Processes, the layout) beside search using the public page toolbar contract. */
export function withScope(page: Extract<Node, { type: "page" }>, showAll: boolean, view?: View): Extract<Node, { type: "page" }> {
	return { ...page, controls: [scopeControl(showAll), ...(view ? [viewControl(view)] : [])] };
}

export function viewValue(payload: Record<string, unknown> | undefined): View | undefined {
	if (payload?.form !== "process-view" || payload.field !== "process-view") return;
	if (payload.value === "grouped" || payload.value === "flat") return payload.value;
}

export function scopeValue(payload: Record<string, unknown> | undefined): boolean | undefined {
	if (payload?.form !== "process-scope" || payload.field !== "process-scope") return;
	if (payload.value === "work") return false;
	if (payload.value === "services") return true;
}
