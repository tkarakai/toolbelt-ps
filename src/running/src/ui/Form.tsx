// Keep / edit form: a few text fields plus an environment checklist.
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { EnvChoice } from "../env.ts";
import { c, fit } from "./theme.ts";

export interface FormValues {
  name: string;
  command: string;
  cwd: string;
  note: string;
  env: EnvChoice[];
}

const FIELDS = ["name", "command", "cwd", "note"] as const;
type Field = (typeof FIELDS)[number];
const LABEL: Record<Field, string> = { name: "Name", command: "Command", cwd: "Directory", note: "Note" };

export function Form(props: {
  title: string;
  initial: FormValues;
  width: number;
  height: number;
  onSubmit: (v: FormValues) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(props.initial);
  const [focus, setFocus] = useState(0); // 0..3 text fields, 4.. env rows
  const [cursor, setCursor] = useState(props.initial.name.length);
  const envCount = v.env.length;
  const total = FIELDS.length + envCount;

  const move = (to: number) => {
    const next = (to + total) % total;
    setFocus(next);
    if (next < FIELDS.length) setCursor(v[FIELDS[next]!].length);
  };

  useInput((input, key) => {
    if (key.escape) return props.onCancel();
    if (key.return) return props.onSubmit(v);
    if (key.tab || /^\t+$/.test(input)) return move(focus + (key.shift ? -1 : input.length || 1));
    if (key.upArrow) return move(focus - 1);
    if (key.downArrow) return move(focus + 1);

    if (focus >= FIELDS.length) {
      if (input === " ") {
        const i = focus - FIELDS.length;
        setV({ ...v, env: v.env.map((e, j) => (j === i ? { ...e, selected: !e.selected } : e)) });
      }
      return;
    }
    const field = FIELDS[focus]!;
    const text = v[field];
    const set = (s: string, cur: number) => { setV({ ...v, [field]: s }); setCursor(cur); };
    if (key.leftArrow) return setCursor(Math.max(0, cursor - 1));
    if (key.rightArrow) return setCursor(Math.min(text.length, cursor + 1));
    if (key.ctrl && input === "a") return setCursor(0);
    if (key.ctrl && input === "e") return setCursor(text.length);
    if (key.ctrl && input === "u") return set(text.slice(cursor), 0);
    if (key.backspace || key.delete) {
      if (cursor > 0) set(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1);
      return;
    }
    // Pasted or burst input can carry control characters (tabs, newlines): never store them.
    const clean = input.replace(/[\x00-\x1f\x7f]/g, "");
    if (clean && !key.ctrl && !key.meta) set(text.slice(0, cursor) + clean + text.slice(cursor), cursor + clean.length);
  });

  const labelW = 11;
  const valueW = Math.max(10, props.width - labelW - 6);
  const envRoom = Math.max(1, props.height - FIELDS.length - 7);
  const envFocus = focus - FIELDS.length;
  const envStart = Math.max(0, Math.min(envFocus - Math.floor(envRoom / 2), envCount - envRoom));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={c.accent} paddingX={1} width={props.width} height={props.height}>
      <Text bold color={c.accent}>{props.title}</Text>
      <Text> </Text>
      {FIELDS.map((f, i) => {
        const active = focus === i;
        const text = v[f];
        // Horizontal scroll so the cursor stays visible in long commands.
        const start = Math.max(0, cursor - valueW + 1);
        const shown = active ? text.slice(start, start + valueW) : fit(text, valueW);
        const cur = cursor - start;
        return (
          <Box key={f}>
            <Text color={active ? c.accent : c.dim}>{fit(LABEL[f], labelW)}</Text>
            {active ? (
              <Text>
                <Text color={c.fg}>{shown.slice(0, cur)}</Text>
                <Text inverse>{shown[cur] ?? " "}</Text>
                <Text color={c.fg}>{shown.slice(cur + 1)}</Text>
              </Text>
            ) : (
              <Text color={text ? c.fg : c.faint}>{text ? shown : fit("—", valueW)}</Text>
            )}
          </Box>
        );
      })}
      <Text> </Text>
      <Text color={envFocus >= 0 ? c.accent : c.dim}>
        Environment{" "}
        <Text color={c.dim}>
          {envCount ? "— variables that differ from a fresh shell; checked ones are saved" : "— nothing unusual"}
        </Text>
      </Text>
      {v.env.slice(envStart, envStart + envRoom).map((e, k) => {
        const i = envStart + k;
        const active = envFocus === i;
        // Never paint a secret on screen in full.
        const shownValue = e.secret && e.value.length > 6 ? `${e.value.slice(0, 4)}…(${e.value.length} chars)` : e.value;
        const line = `${e.key}=${shownValue}`;
        return (
          <Text key={e.key} backgroundColor={active ? c.selBg : undefined}>
            <Text color={e.selected ? c.green : c.dim}>{e.selected ? " [x] " : " [ ] "}</Text>
            <Text color={e.secret ? c.yellow : active ? c.fg : c.dim}>
              {fit((e.secret ? "🔒" : "") + line, valueW + labelW - 8)}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
