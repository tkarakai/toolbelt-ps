// A client for running-core (src/serve.ts in github.com/tkarakai/running): one JSON object per
// line over stdio. Requests resolve with `result` or reject with `error`; `{"event":"changed"}`
// (a port probe finished) calls `onChanged`.
import { existsSync } from "node:fs";

export type Listen = { pid: number; port: number; host: string };
export type Member = { pid: number; ppid: number; depth: number; displayArgv: string[]; argvCommand: string; cwd: string; listen: Listen[]; tty: string; stat: string; etimeSec: number; rssKb: number; cpu: number; pidCount: number };
export type Agent = { harness: string; title?: string; model?: string; tokens?: number; costUsd?: number; lastActive?: number; status?: "working" | "idle" | "new"; branch?: string; resume?: string; sessionId?: string; transcript?: string };
export type ProcRow = {
	pid: number; pgid?: number; kind: "job" | "term" | "server" | "daemon" | "app" | string; command: string; argvCommand: string; displayArgv: string[];
	source: "typed" | "script" | "history" | "argv" | string; leaderGone: boolean; exe?: string; cwd: string; listen: Listen[]; where: string; tty: string;
	stat: string; etimeSec: number; rssKb: number; cpu: number; pidCount: number; members: Member[]; parentRow?: number; via?: string;
	term?: Record<string, string>; cmux?: { workspace: string; surface: string }; termLabel: string; shellAlive: boolean; keptIndex?: number; agent?: Agent;
};
export type KeptDTO = { index: number; name?: string; command: string; cwd: string; env: Record<string, string>; note: string; ports: number[]; session?: string; kept?: string; line: string; livePid?: number };
export type Probe = { pid: number; port: number; pending: boolean; web?: boolean; url?: string; title?: string; status?: number };
export type SortKey = "started" | "memory" | "cpu" | "name";
export type Snapshot = { at: number; rows: ProcRow[]; kept: KeptDTO[]; probes: Probe[]; branches: Record<string, string | null>; sort: { key: SortKey; desc: boolean } };
export type SortSpec = { label: string; desc: boolean; dirLabel: [string, string] };
export type Hello = {
	version: string; keptFile: string; logFile: string;
	shell: { zshrc: boolean; logExists: boolean; logAgeSec?: number };
	terminals: Record<string, { label: string; app?: string }>;
	sorts: Record<SortKey, SortSpec>;
};
export type EnvChoice = { key: string; value: string; secret: boolean; selected: boolean };
export type KeepDraft = { alreadyKept?: { index: number; name?: string }; title: string; name: string; command: string; cwd: string; note: string; env: EnvChoice[] };
export type Peek = { title: string; lines: string[]; sources: string[]; source?: string; kind: "output" | "conversation" };

export class Core {
	error: string | null;
	private proc: ReturnType<typeof Bun.spawn> | null = null;
	private nextId = 1;
	private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

	constructor(
		readonly script: string,
		private readonly hooks: { onChanged: () => void; onExit: (msg: string) => void },
	) {
		this.error = existsSync(script) ? null : `running-core not found at ${script}`;
	}

	stop() {
		this.proc?.kill();
		this.proc = null;
	}

	start() {
		if (this.error) return;
		const proc = Bun.spawn([process.execPath, this.script], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, ...(process.env.TOOLBELT_DATA_DIR ? {RUNNING_CONFIG_DIR: process.env.TOOLBELT_DATA_DIR + "/running", RUNNING_LOG_FILE: process.env.TOOLBELT_DATA_DIR + "/commands.log"} : {}) } });
		this.proc = proc;
		void (async () => {
			const decoder = new TextDecoder();
			let buf = "";
			for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
				buf += decoder.decode(chunk, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					let msg: any;
					try {
						msg = JSON.parse(line);
					} catch {
						continue;
					}
					if (msg.event === "changed") this.hooks.onChanged();
					if (typeof msg.id === "number" && !msg.event && this.waiting.has(msg.id)) {
						const w = this.waiting.get(msg.id)!;
						this.waiting.delete(msg.id);
						msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result);
					}
				}
			}
		})();
		void proc.exited.then((code) => {
			this.error = `running-core exited (${code})`;
			for (const w of this.waiting.values()) w.reject(new Error(this.error));
			this.waiting.clear();
			this.hooks.onExit(this.error);
		});
	}

	get running() {
		return !!this.proc && !this.error;
	}

	call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		if (!this.proc || this.error) return Promise.reject(new Error(this.error ?? "running-core isn't running"));
		const id = this.nextId++;
		const sink = this.proc.stdin as import("bun").FileSink;
		sink.write(JSON.stringify({ id, method, params }) + "\n");
		sink.flush();
		return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
	}
}
