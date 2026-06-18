import { describe, expect, it } from "vitest";
import type { PipelineEvent } from "../src/events.js";
import type { FinalRecord, WorkItem } from "../src/contracts.js";
import {
  emptyModel,
  moveSelection,
  reduce,
  selectedItem,
  type TuiModel,
} from "../src/renderers/ink/model.js";

function wi(id: string, dependsOn: string[] = []): WorkItem {
  return { id, title: `title ${id}`, description: "", acceptanceCriteria: [], dependsOn };
}

function finalRecord(item: WorkItem, passed: boolean, attempts: number): FinalRecord {
  return {
    workItem: item,
    passed,
    attempts,
    sourceCode: null,
    testSource: null,
    lastError: passed ? null : "boom",
    patch: null,
  };
}

function drive(events: PipelineEvent[]): TuiModel {
  let m = emptyModel();
  for (const e of events) m = reduce(m, e);
  return m;
}

describe("ink model reducer", () => {
  const a = wi("wi-001");
  const b = wi("wi-002");
  const c = wi("wi-003", ["wi-001"]); // depends on a

  it("creates items from wbs.created with correct initial stages", () => {
    const m = drive([{ type: "wbs.created", items: [a, b, c] }]);
    expect(m.total).toBe(3);
    expect(m.items.map((i) => i.id)).toEqual(["wi-001", "wi-002", "wi-003"]);
    expect(m.items.find((i) => i.id === "wi-003")!.stage).toBe("blocked");
    expect(m.items.find((i) => i.id === "wi-001")!.stage).toBe("queued");
  });

  it("returns a NEW model reference on a handled event (immutability)", () => {
    const m0 = emptyModel();
    const m1 = reduce(m0, { type: "wbs.created", items: [a] });
    expect(m1).not.toBe(m0);
    expect(m0.items).toHaveLength(0); // original untouched
  });

  it("returns the SAME reference on an unhandled / no-op event", () => {
    const m0 = drive([{ type: "wbs.created", items: [a] }]);
    const m1 = reduce(m0, { type: "pipeline.done", records: [] });
    expect(m1).toBe(m0);
  });

  it("tracks stage activity on start/complete", () => {
    const m = drive([
      { type: "wbs.created", items: [a, b] },
      { type: "item.enqueued", stage: "designer", itemId: "wi-001", queueDepth: 1 },
      { type: "item.started", stage: "designer", itemId: "wi-001", worker: 0 },
    ]);
    expect(m.designer.active).toContain("wi-001");
    expect(m.items.find((i) => i.id === "wi-001")!.stage).toBe("design");

    const m2 = reduce(m, { type: "item.completed", stage: "designer", itemId: "wi-001", worker: 0 });
    expect(m2.designer.active).not.toContain("wi-001");
  });

  it("counts done/passed/failed and updates item status on finalize", () => {
    const m = drive([
      { type: "wbs.created", items: [a, b] },
      { type: "item.finalized", record: finalRecord(a, true, 1) },
      { type: "item.finalized", record: finalRecord(b, false, 2) },
    ]);
    expect(m.done).toBe(2);
    expect(m.passed).toBe(1);
    expect(m.failed).toBe(1);
    const ia = m.items.find((i) => i.id === "wi-001")!;
    expect(ia.stage).toBe("done");
    expect(ia.passed).toBe(true);
    const ib = m.items.find((i) => i.id === "wi-002")!;
    expect(ib.passed).toBe(false);
    expect(ib.lastError).toBe("boom");
  });

  it("counts reworks both globally and per-item", () => {
    const m = drive([
      { type: "wbs.created", items: [a] },
      { type: "item.reworked", itemId: "wi-001", attempt: 2, feedback: "fix it" },
      { type: "item.reworked", itemId: "wi-001", attempt: 3, feedback: "again" },
    ]);
    expect(m.reworks).toBe(2);
    const ia = m.items.find((i) => i.id === "wi-001")!;
    expect(ia.reworks).toBe(2);
    expect(ia.lastError).toBe("again");
  });

  it("tracks blocked count via blocked/unblocked", () => {
    const m = drive([
      { type: "wbs.created", items: [a, c] },
      { type: "item.blocked", itemId: "wi-003", dependsOn: ["wi-001"] },
    ]);
    expect(m.blocked).toBe(1);
    const m2 = reduce(m, { type: "item.unblocked", itemId: "wi-003" });
    expect(m2.blocked).toBe(0);
    expect(m2.items.find((i) => i.id === "wi-003")!.stage).toBe("queued");
  });

  it("sets the paused flag on pause/resume", () => {
    const m = drive([
      { type: "wbs.created", items: [a] },
      { type: "pipeline.paused", at: 1 },
    ]);
    expect(m.paused).toBe(true);
    expect(reduce(m, { type: "pipeline.resumed", at: 2 }).paused).toBe(false);
  });

  it("sets the cancelled flag", () => {
    const m = drive([
      { type: "wbs.created", items: [a] },
      { type: "pipeline.cancelled", reason: "stopped" },
    ]);
    expect(m.cancelled).toBe(true);
  });

  it("accumulates busyMs from metrics and tracks attempts", () => {
    const m = drive([
      { type: "wbs.created", items: [a] },
      { type: "item.metrics", stage: "developer", itemId: "wi-001", attempt: 2, durationMs: 150 },
      { type: "item.metrics", stage: "tester", itemId: "wi-001", attempt: 2, durationMs: 50 },
    ]);
    expect(m.busyMs).toBe(200);
    expect(m.items.find((i) => i.id === "wi-001")!.attempts).toBe(2);
  });

  it("surfaces repo-mode events in recent / lastError", () => {
    const m = drive([
      { type: "wbs.created", items: [a] },
      { type: "item.patch.applied", itemId: "wi-001", attempt: 1, files: ["a.ts", "b.ts"] },
      { type: "item.command", itemId: "wi-001", command: "npm test", passed: false, detail: "test failed line 3" },
    ]);
    expect(m.recent.some((l) => l.includes("patched 2 file"))).toBe(true);
    expect(m.recent.some((l) => l.includes("npm test FAIL"))).toBe(true);
    expect(m.items.find((i) => i.id === "wi-001")!.lastError).toBe("test failed line 3");
  });

  it("keeps recent capped at 8 lines", () => {
    const events: PipelineEvent[] = [{ type: "wbs.created", items: [a] }];
    for (let i = 0; i < 20; i++) {
      events.push({ type: "item.unblocked", itemId: "wi-001" });
    }
    const m = drive(events);
    expect(m.recent.length).toBeLessThanOrEqual(8);
  });

  describe("selection", () => {
    const base = drive([{ type: "wbs.created", items: [a, b, c] }]);

    it("starts at 0 and clamps within bounds", () => {
      expect(base.selectedIndex).toBe(0);
      const up = moveSelection(base, -1);
      expect(up.selectedIndex).toBe(0); // clamp low
      const d1 = moveSelection(base, 1);
      expect(d1.selectedIndex).toBe(1);
      const d10 = moveSelection(base, 10);
      expect(d10.selectedIndex).toBe(2); // clamp high (3 items)
    });

    it("returns same ref when selection does not change", () => {
      const same = moveSelection(base, -1);
      expect(same).toBe(base);
    });

    it("selectedItem returns the right item, null when empty", () => {
      expect(selectedItem(base)!.id).toBe("wi-001");
      expect(selectedItem(moveSelection(base, 2))!.id).toBe("wi-003");
      expect(selectedItem(emptyModel())).toBeNull();
    });

    it("clamps a stale selection on an empty list", () => {
      const m = { ...emptyModel(), selectedIndex: 5 };
      const moved = moveSelection(m, 0);
      expect(moved.selectedIndex).toBe(0);
    });
  });
});
