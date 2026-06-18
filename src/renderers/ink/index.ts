/**
 * Attach point for the Ink TUI — the interactive renderer.
 *
 * Like every other renderer it takes the engine's `on` subscription; unlike the
 * read-only renderers it also takes a `send` so keystrokes can push
 * PipelineCommands back into the running pipeline. Returns a detach function that
 * unmounts the Ink tree (used by the CLI's renderer-teardown path).
 *
 * The live TUI needs a real TTY (stdin in raw mode). In tests, render the App
 * directly with `ink-testing-library` instead of calling this.
 */
import React from "react";
import { render } from "ink";
import type { EventListener } from "../../events.js";
import type { PipelineCommand } from "../../commands.js";
import { App } from "./App.js";

export function attachInkRenderer(
  on: (l: EventListener) => () => void,
  send: (c: PipelineCommand) => void,
): () => void {
  const instance = render(React.createElement(App, { on, send }));
  return () => {
    instance.unmount();
  };
}
