/**
 * Inbound control channel — the serializable mirror of the outbound event stream.
 *
 * The engine emits PipelineEvents OUT; a consumer (the CLI's TUI today, the
 * phase-2 VS Code webview tomorrow) sends PipelineCommands IN. Both directions
 * are plain JSON so the webview bridge is symmetric: `panel.webview.postMessage(e)`
 * to push events out, and `webview.onDidReceiveMessage(cmd => pipeline.send(cmd))`
 * to push commands in.
 *
 * This module is part of the engine: it imports nothing from `vscode` and nothing
 * CLI-only, and produces no output. Every PipelineCommand payload must survive
 * JSON.parse(JSON.stringify(cmd)) unchanged (enforced by a test).
 */

export type PipelineCommand =
  | { type: "run.cancel"; reason: string }
  | { type: "pipeline.pause" }
  | { type: "pipeline.resume" }
  | { type: "item.cancel"; itemId: string; reason: string }
  | { type: "item.retry"; itemId: string }
  | { type: "item.reprioritize"; itemId: string; priority: number };

export type PipelineCommandType = PipelineCommand["type"];

export type CommandHandler = (command: PipelineCommand) => void;

/**
 * Inbound analogue of EventBus. Unlike events (broadcast to many renderers),
 * commands are consumed by exactly one party — the running engine — so the bus
 * holds a single handler installed for the duration of a run. `send` before a run
 * starts or after it ends is a safe no-op.
 */
export class CommandBus {
  private handler: CommandHandler | null = null;

  /** Engine-side: install the run's command handler. Returns an uninstaller. */
  onCommand(handler: CommandHandler): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }

  /** Consumer-side: send a command into the running pipeline. */
  send(command: PipelineCommand): void {
    this.handler?.(command);
  }
}
