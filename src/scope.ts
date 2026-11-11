import type { Node } from "@toolbelt/sdk";

export function scopeControl(showAll: boolean) {
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

/** Toolbar extension is structurally compatible with the pinned SDK's page node. */
export function withScope(page: Extract<Node, { type: "page" }>, showAll: boolean) {
	return { ...page, controls: [scopeControl(showAll)] };
}

export function scopeValue(payload: Record<string, unknown> | undefined): boolean | undefined {
	if (payload?.form !== "process-scope" || payload.field !== "process-scope") return;
	if (payload.value === "work") return false;
	if (payload.value === "services") return true;
}
