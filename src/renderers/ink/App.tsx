/**
 * The Ink (React-for-terminals) TUI component.
 *
 * It is a pure subscriber to the engine's event stream (via `on`) and a sender of
 * control commands (via `send`) — the interactive counterpart of the read-only
 * terminal renderer. The whole view is derived from a `TuiModel` reduced from the
 * stream; keystrokes only ever (a) move a purely-local selection cursor or
 * (b) send a PipelineCommand back into the engine. The engine has no idea the TUI
 * exists.
 */
import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { EventListener } from "../../events.js";
import type { PipelineCommand } from "../../commands.js";
import {
  emptyModel,
  moveSelection,
  reduce,
  selectedItem,
  type ItemStage,
  type TuiModel,
} from "./model.js";

export interface AppProps {
  on: (l: EventListener) => () => void;
  send: (c: PipelineCommand) => void;
}

const STAGE_ROWS: Array<{ key: "designer" | "developer" | "tester"; label: string }> = [
  { key: "designer", label: "designer" },
  { key: "developer", label: "developer" },
  { key: "tester", label: "tester" },
];

const STAGE_TEXT: Record<ItemStage, string> = {
  queued: "queued",
  blocked: "blocked",
  design: "design",
  develop: "develop",
  test: "test",
  done: "done",
};

function statusIcon(passed: boolean | null): string {
  if (passed === null) return "⏳";
  return passed ? "✅" : "❌";
}

function truncate(s: string, n: number): string {
  const flat = s.split("\n").find((l) => l.trim().length > 0) ?? s;
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

export function App({ on, send }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [model, setModel] = useState<TuiModel>(emptyModel);

  useEffect(() => {
    const off = on((e) => {
      setModel((m) => reduce(m, e));
      if (e.type === "pipeline.done") {
        // Let the final frame flush, then unmount.
        setTimeout(() => exit(), 0);
      }
    });
    return off;
  }, [on, exit]);

  useInput((input, key) => {
    if (input === " " || input === "p") {
      send(model.paused ? { type: "pipeline.resume" } : { type: "pipeline.pause" });
      return;
    }
    if (key.upArrow) {
      setModel((m) => moveSelection(m, -1));
      return;
    }
    if (key.downArrow) {
      setModel((m) => moveSelection(m, 1));
      return;
    }
    if (input === "x") {
      const sel = selectedItem(model);
      if (sel && sel.passed === null) {
        send({ type: "item.cancel", itemId: sel.id, reason: "skipped via TUI" });
      }
      return;
    }
    if (input === "c") {
      send({ type: "run.cancel", reason: "cancelled via TUI" });
      return;
    }
    if (input === "q") {
      send({ type: "run.cancel", reason: "cancelled via TUI" });
      exit();
      return;
    }
  });

  const sel = selectedItem(model);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text bold>Multi-agent pipeline</Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text>
          done <Text bold>{`${model.done}/${model.total}`}</Text>
        </Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text>
          <Text color="green">{model.passed}</Text> pass <Text color="red">{model.failed}</Text> fail
        </Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text>
          reworks <Text color="yellow">{model.reworks}</Text>
        </Text>
        {model.blocked > 0 ? (
          <Text>
            <Text dimColor>{"  ·  "}</Text>
            blocked <Text color="yellow">{model.blocked}</Text>
          </Text>
        ) : null}
        <Text dimColor>{"  ·  "}</Text>
        <Text>
          busy <Text bold>{`${(model.busyMs / 1000).toFixed(1)}s`}</Text>
        </Text>
        {model.paused ? (
          <Text>
            <Text dimColor>{"  ·  "}</Text>
            <Text color="yellow">PAUSED</Text>
          </Text>
        ) : null}
        {model.cancelled ? (
          <Text>
            <Text dimColor>{"  ·  "}</Text>
            <Text color="yellow">CANCELLED</Text>
          </Text>
        ) : null}
      </Box>

      {/* Stage rows */}
      <Box flexDirection="column" marginTop={1}>
        {STAGE_ROWS.map(({ key, label }) => {
          const stage = model[key];
          const active = stage.active;
          return (
            <Box key={key}>
              <Text>{active.length > 0 ? <Text color="green">●</Text> : <Text dimColor>○</Text>} </Text>
              <Text bold>{label.padEnd(10)}</Text>
              <Text dimColor>{`q:${stage.depth}`.padEnd(6)}</Text>
              {active.length > 0 ? (
                <Text color="green">{active.join(" ")}</Text>
              ) : (
                <Text dimColor>idle</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Items list */}
      <Box flexDirection="column" marginTop={1}>
        {model.items.length === 0 ? (
          <Text dimColor>(no work items yet)</Text>
        ) : (
          model.items.map((it, i) => {
            const selected = i === model.selectedIndex;
            return (
              <Text key={it.id} inverse={selected} color={selected ? "cyan" : undefined}>
                {`${statusIcon(it.passed)} ${it.id}  ${STAGE_TEXT[it.stage].padEnd(8)} ${truncate(it.title, 40)}`}
              </Text>
            );
          })
        )}
      </Box>

      {/* Detail pane */}
      {sel ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>detail:</Text>
          <Text>
            {`  ${sel.id} `}
            <Text bold>{STAGE_TEXT[sel.stage]}</Text>
            {`  attempts=${sel.attempts}  reworks=${sel.reworks}`}
          </Text>
          {sel.lastError ? (
            <Text color="red">{`  error: ${truncate(sel.lastError, 80)}`}</Text>
          ) : (
            <Text dimColor>  no errors</Text>
          )}
        </Box>
      ) : null}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>[space] pause  [↑/↓] select  [x] skip  [c] cancel  [q] quit</Text>
      </Box>
    </Box>
  );
}

export default App;
