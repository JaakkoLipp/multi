/**
 * Smoke test for the Ink App via ink-testing-library. Uses React.createElement
 * (not JSX) so the file stays `.test.ts` and is collected by the root runner's
 * `test/**\/*.test.ts` glob. Ink renders asynchronously, so we await a tick after
 * firing events before asserting on the frame.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/renderers/ink/App.js";
import type { EventListener, PipelineEvent } from "../src/events.js";
import type { WorkItem } from "../src/contracts.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function wi(id: string): WorkItem {
  return { id, title: `title ${id}`, description: "", acceptanceCriteria: [], dependsOn: [] };
}

describe("ink App smoke", () => {
  it("renders stage names and item ids from the event stream", async () => {
    let listener: EventListener | null = null;
    const on = (l: EventListener) => {
      listener = l;
      return () => {
        listener = null;
      };
    };
    const sent: unknown[] = [];
    const send = (c: unknown) => sent.push(c);

    const { lastFrame, unmount } = render(React.createElement(App, { on, send }));
    await delay(20);

    const fire = (e: PipelineEvent) => listener?.(e);
    fire({ type: "wbs.created", items: [wi("wi-001"), wi("wi-002")] });
    fire({ type: "item.started", stage: "designer", itemId: "wi-001", worker: 0 });
    await delay(30);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Multi-agent pipeline");
    expect(frame).toContain("designer");
    expect(frame).toContain("developer");
    expect(frame).toContain("tester");
    expect(frame).toContain("wi-001");
    expect(frame).toContain("wi-002");
    // Footer hint is present.
    expect(frame).toContain("pause");

    unmount();
  });
});
