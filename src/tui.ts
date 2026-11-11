// The Settings card for running's terminal UI and its zsh hook (see install.ts): what's bundled,
// what a new terminal finds, and Install / Remove / Check again.
import { existsSync } from "node:fs";
import type { Action, Context, Node, Tone } from "@toolbelt/sdk";
import { dur } from "./model";
import { HOOK, MARK, homeDir, install, needsPathLine, pathsFor, probe, readZshrc, remove, wrapperState, type Probe } from "./install";
import { tuiScript } from "./paths";

export type ShellLog = { logFile: string; logExists: boolean; logAgeSec?: number };

export class Tui {
	result: Probe | null = null;
	checking = false;
	private checked = false;

	constructor(
		readonly opts: { home?: string; bun?: string; tui?: string; onChange: () => void } = { onChange: () => {} },
	) {}

	get home() {
		return this.opts.home ?? homeDir();
	}
	get bun() {
		return this.opts.bun ?? process.execPath;
	}
	get tui() {
		return this.opts.tui ?? tuiScript();
	}

	/** Check once, the first time the card is on screen. */
	checkOnce() {
		if (this.checked) return;
		this.checked = true;
		setTimeout(() => void this.check(), 0); // not while rendering
	}

	async check() {
		if (this.checking) return;
		this.checked = this.checking = true;
		this.opts.onChange();
		this.result = await probe(this.home);
		this.checking = false;
		this.opts.onChange();
	}

	private tilde = (p: string) => (p === this.home ? "~" : p.startsWith(this.home + "/") ? "~" + p.slice(this.home.length) : p);

	/** What Install would change, for its confirmation. */
	private plan() {
		const p = pathsFor(this.home);
		const state = wrapperState(p, this.bun, this.tui);
		const z = readZshrc(p);
		const lines = [...(!z.pathLine && needsPathLine(p, this.result) ? ["~/.local/bin on PATH"] : []), ...(z.hook === "none" ? ["the zsh hook"] : [])];
		const steps = [
			...(state === "foreign" ? [`Your ${this.tilde(p.wrapper)} isn't Toolbelt's: it moves to ${this.tilde(p.backup)}, and Remove puts it back.`] : []),
			...(state !== "current" ? [`${state === "stale" ? "Updates" : "Writes"} ${this.tilde(p.wrapper)}, which runs the bundled TUI.`] : []),
			...(lines.length ? [`Adds ${lines.join(" and ")} to ${this.tilde(p.zshrc)} (lines marked “${MARK}”).`] : []),
		];
		return { state, z, steps };
	}

	card(log: ShellLog | null, version: string | undefined): Node {
		const p = pathsFor(this.home);
		const { state, z, steps } = this.plan();
		const r = this.result;
		const ours = state === "current" || state === "stale";
		const first = r?.ok ? r.found[0] : undefined;
		const firstIsOurs = !!first && first === p.wrapper && ours;
		const working = !!r?.ok && !!first && r.hookLoaded;

		const found: { value: string; tone: Tone } = this.checking && !r
			? { value: "checking…", tone: "muted" }
			: !r
				? { value: "not checked", tone: "muted" }
				: !r.ok
					? { value: `couldn't check — ${r.error}`, tone: "warning" }
					: !first
						? { value: "not found — Install puts it on your PATH", tone: "warning" }
						: { value: `${this.tilde(first)}${firstIsOurs ? " (Toolbelt's)" : " (another install)"}${r.version ? ` · ${r.version}` : ""}`, tone: firstIsOurs ? "success" : "default" };

		const items: { label: string; value: string; mono?: boolean; tone?: Tone }[] = [
			{ label: "Start it", value: "running   (running --help for more)", mono: true },
			{ label: "Bundled", value: `${this.tilde(this.tui)}${version ? ` · ${version}` : ""}`, mono: true },
			{ label: "New terminals find", value: found.value, tone: found.tone, mono: !!first },
			...(r?.ok && r.found.length > 1 ? [{ label: "Also on PATH", value: r.found.slice(1).map(this.tilde).join(", "), mono: true }] : []),
			{
				label: this.tilde(p.wrapper),
				value: { missing: "none", current: "Toolbelt's wrapper", stale: "Toolbelt's wrapper, for another copy — Install updates it", foreign: "yours (not Toolbelt's)" }[state],
				tone: state === "stale" ? "warning" : "default",
			},
			{
				label: `Startup (${this.tilde(p.zshrc)})`,
				value: [{ toolbelt: "hook added by Toolbelt", yours: "your hook line", none: "no hook line" }[z.hook], ...(z.pathLine ? ["PATH line added by Toolbelt"] : [])].join(" · "),
				tone: z.hook === "none" ? "warning" : "default",
			},
			...(r?.ok ? [{ label: "Hook in new terminals", value: r.hookLoaded ? "loaded" : "not loaded", tone: (r.hookLoaded ? "success" : "warning") as Tone }] : []),
			{
				label: "Command log",
				value: log?.logExists ? `written ${log.logAgeSec !== undefined ? dur(log.logAgeSec) + " ago" : ""}` : "none yet — the hook writes it",
				tone: log?.logExists ? "default" : "warning",
			},
			{ label: "Setup line", value: HOOK, mono: true },
		];

		const needsInstall = state !== "current" || z.hook === "none";
		const actions: Action[] = [
			...(needsInstall
				? [{ id: "tui-install", label: state === "stale" ? "Update" : "Install", icon: "download", primary: !working, disabled: this.checking, confirm: steps.join(" ") || undefined }]
				: []),
			...(ours || z.ourLines
				? [{
						id: "tui-remove",
						label: "Remove",
						icon: "undo-2",
						tone: "destructive" as const,
						confirm: [
							...(ours ? [`Deletes ${this.tilde(p.wrapper)}${existsSync(p.backup) ? ` and puts back the one it replaced` : ""}.`] : []),
							...(z.ourLines ? [`Removes the ${z.ourLines} line${z.ourLines > 1 ? "s" : ""} marked “${MARK}” from ${this.tilde(p.zshrc)}.`] : []),
						].join(" "),
					}]
				: []),
			{ id: "tui-check", label: this.checking ? "Checking…" : "Check again", icon: "refresh-cw", disabled: this.checking },
			{ id: "copy-init", label: "Copy setup line", icon: "copy" },
		];

		return {
			type: "card",
			id: "tui",
			title: "running in your terminal",
			description:
				"Processes ships running's terminal UI. Install puts the running command on your PATH and its zsh hook in ~/.zshrc: the hook remembers the commands you type, so Processes and the TUI can show what you typed, restart it, and name jobs whose launcher exited. Optional — without it, Processes still lists everything.",
			tone: !r || this.checking ? "default" : working ? "success" : "warning",
			actions,
			children: [{ type: "details", items }],
		};
	}

	/** Handles tui-install / tui-remove / tui-check; false for other events. */
	async onEvent(event: string, c: Context, after: () => Promise<void>): Promise<boolean> {
		if (event === "tui-check") {
			await this.check();
			await after();
			return true;
		}
		if (event !== "tui-install" && event !== "tui-remove") return false;
		const res = event === "tui-install" ? install({ home: this.home, bun: this.bun, tui: this.tui, probe: this.result }) : remove({ home: this.home });
		c.toast(res.message, res.ok ? "success" : "error");
		await this.check();
		await after();
		return true;
	}
}
