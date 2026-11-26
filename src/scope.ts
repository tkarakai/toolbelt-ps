import type { Node, View as SdkView, ViewDeclaration } from "@toolbelt/sdk";
import { FILTERS, type FilterId, type View } from "./model";

/** Page control ids: the scope and the table layout. Form and field ids equal them. */
export const SCOPE = "process-scope";
export const LAYOUT = "process-view";

export function scopeControl(showAll: boolean): Extract<Node, { type: "segmented" }> {
	return {
		type: "segmented" as const,
		id: SCOPE,
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
		id: LAYOUT,
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

/** What Processes saved before ToolBelt kept the view (prefs.json): only read, as where views start. */
export type SavedChoices = { showAll?: boolean; view?: string; filters?: Partial<Record<FilterId, string[]>> };

/**
 * The Processes screen's view: search, the Agent and State filters, and the scope and layout
 * controls. The SDK applies their events and ToolBelt saves the person's; the choices people saved
 * before are the defaults, so nothing changes for them on upgrade. Sort stays the plugin's: the
 * engine sorts once for everyone (see docs/architecture.md).
 */
export function processesView(saved: SavedChoices): ViewDeclaration {
	return {
		search: true,
		filters: Object.fromEntries(FILTERS.map((f) => [f.id, [...(saved.filters?.[f.id] ?? [])]])),
		controls: { [SCOPE]: saved.showAll === true ? "services" : "work", [LAYOUT]: saved.view === "flat" ? "flat" : "grouped" },
	};
}

/** The choices a view makes on the Processes screen. Unknown control values read as Your Work and Grouped. */
export function readView(view: Pick<SdkView, "search" | "filters" | "controls">): { query: string; filters: Partial<Record<FilterId, string[]>>; showAll: boolean; layout: View } {
	return {
		query: view.search,
		filters: Object.fromEntries(FILTERS.map((f) => [f.id, [...(view.filters[f.id] ?? [])]])),
		showAll: view.controls[SCOPE] === "services",
		layout: view.controls[LAYOUT] === "flat" ? "flat" : "grouped",
	};
}
