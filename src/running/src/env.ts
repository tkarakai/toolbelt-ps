// Which environment variables are worth offering when keeping a process?
// Those that differ from what a fresh shell would have anyway: compared both
// against the launching shell and against our own environment. That surfaces
// `FOO=1 cmd` prefixes and things exported in that terminal session, and hides
// the hundred variables every process inherits.

const NOISE = [
  /^(PWD|OLDPWD|SHLVL|_|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_\w+|PAGER|LESS|EDITOR|VISUAL)$/,
  /^(TERM|TERM_\w+|COLORTERM|COLUMNS|LINES|TMUX|TMUX_\w+|ITERM_\w+|VSCODE_\w+|WINDOWID|DISPLAY)$/,
  /^(SSH_\w+|XPC_\w+|__CF\w+|COMMAND_MODE|MallocNanoZone|SECURITYSESSIONID|Apple_\w+|LaunchInstanceID)$/,
  /^(LS_COLORS|LSCOLORS|ZSH|ZSH_\w+|P9K_\w+|NVM_\w+|npm_\w+|INIT_CWD|ATUIN_\w+|HOMEBREW_\w+|INFOPATH|MANPATH)$/,
  /^(ORCA_\w+|T3_\w+|T3CODE_\w+|CLAUDECODE|CLAUDE_CODE_\w+|CODEX_\w+|GHOSTTY_\w+|KITTY_\w+|WEZTERM_\w+|ALACRITTY_\w+)$/,
  /^__\w+$/, // interpreter internals like __PYVENV_LAUNCHER__
  /^(RUNNING_ACTION_FILE|OTEL_\w+|BUN_INSTALL|GOPATH|FPATH|PNPM_HOME|POWERLEVEL9K_\w+|FORCE_HYPERLINK|GCM_INTERACTIVE|GIT_TERMINAL_PROMPT|JCODE_\w+)$/,
];

const SECRET = /(KEY|TOKEN|SECRET|PASSW|PASS$|AUTH|CREDENTIAL|PRIVATE|COOKIE|SESSION)/i;

export interface EnvChoice {
  key: string;
  value: string;
  secret: boolean;
  selected: boolean;
}

/** `FOO=1 BAR=x cmd …` → {FOO, BAR}: already part of a typed command, so not offered again. */
export function prefixVars(command: string): Set<string> {
  const out = new Set<string>();
  for (const word of command.split(/\s+/)) {
    const m = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) break;
    out.add(m[1]!);
  }
  return out;
}

export function envChoices(
  env: Record<string, string>,
  shellEnv: Record<string, string>,
  ownEnv: Record<string, string | undefined> = process.env,
  skip: Set<string> = new Set(),
): EnvChoice[] {
  const out: EnvChoice[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (skip.has(key) || NOISE.some((re) => re.test(key))) continue;
    if (shellEnv[key] === value || ownEnv[key] === value) continue;
    const secret = SECRET.test(key);
    out.push({ key, value, secret, selected: !secret && key !== "PATH" });
  }
  return out.sort((a, b) => Number(a.secret) - Number(b.secret) || a.key.localeCompare(b.key));
}
