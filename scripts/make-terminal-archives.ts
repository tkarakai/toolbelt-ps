#!/usr/bin/env bun
// Release the same patched running TUI that ships inside Toolbelt, in Running's two formats.
import { $ } from "bun";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTerminalArchives(root = join(import.meta.dir, "..")): Promise<string[]> {
    const version: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const runningVersion: string = JSON.parse(readFileSync(join(root, "src/running/package.json"), "utf8")).version;
    const bundle = join(root, "dist/package/payload/bin/running");
    const stage = mkdtempSync(join(tmpdir(), "toolbelt-terminal-"));
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    try {
        const standalone = join(stage, "running-standalone");
        // Give the extensionless executable a JS suffix so Bun compiles code, not a file asset.
        const source = join(stage, "running.js");
        copyFileSync(bundle, source);
        await $`bun build ${source} --compile --minify --outfile ${standalone}`.quiet();
        const assets: string[] = [];
        for (const [bin, suffix] of [[bundle, "macos"], [standalone, "macos-arm64-standalone"]]) {
            const executable = join(stage, "running");
            copyFileSync(bin, executable);
            const asset = join(artifacts, `toolbelt-${version}-${suffix}.tar.xz`);
            await $`tar -cJf ${asset} -C ${stage} running`.quiet();
            // Check the actual download, including executable permissions and embedded shell hook.
            const extracted = join(stage, suffix);
            mkdirSync(extracted);
            await $`tar -xf ${asset} -C ${extracted}`.quiet();
            const env = { ...process.env, RUNNING_CONFIG_DIR: join(stage, "config"), RUNNING_LOG_FILE: join(stage, "commands.log") };
            const command = join(extracted, "running");
            const reported = (await $`${command} --version`.env(env).text()).trim();
            if (reported !== runningVersion) throw new Error(`${asset}: running reports ${reported}, expected ${runningVersion}`);
            const help = await $`${command} --help`.env(env).text();
            if (!help.includes(`built with ${Bun.version}, running on ${Bun.version}`)) throw new Error(`${asset}: incorrect Bun version`);
            const init = await $`${command} init`.env(env).text();
            if (!init.includes("preexec")) throw new Error(`${asset}: missing zsh hook`);
            assets.push(asset);
        }
        return assets;
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    process.chdir(join(import.meta.dir, ".."));
    await $`bun run build`;
    for (const asset of await makeTerminalArchives()) console.log(asset);
}
