/**
 * System instructions + user-prompt rendering for the model-driven stages.
 * Kept separate so the Mastra Agent definitions read as just (instructions +
 * model), and so the prompts are easy to tune without touching wiring.
 */
import type { DesignSpec } from "../contracts.js";
import type { DesignInput, DependencyContext, DevelopInput, WriteTestsInput } from "./types.js";

export const ORCHESTRATOR_INSTRUCTIONS = `You are an orchestrator that decomposes a single software request into a Work Breakdown Structure.
Prefer INDEPENDENT work items so they can be built concurrently. For a request like
"a module exporting functions a, b, c", produce one work item per function.
Give each item:
- key: a short stable handle (e.g. "slugify") you can reference from other items.
- title, a precise description, and 2-5 concrete acceptance criteria.
- dependsOn: the keys of items this one genuinely builds upon (usually empty). Only add a
  dependency when an item's design legitimately needs another's; keep the graph shallow and
  acyclic. Independent items run in parallel, so do not invent dependencies.
Do not exceed the requested maximum number of items.`;

export const DESIGNER_INSTRUCTIONS = `You are a software designer. Given one work item, produce a precise design spec for a single exported TypeScript function.
- functionName: the exact identifier to export.
- signature: a full TypeScript signature, e.g. "export function slugify(text: string): string".
- behavior: one paragraph describing exactly what the function does.
- edgeCases: concrete edge cases the implementation must handle.
- examples: input -> output examples, written as short strings.
Be concrete and unambiguous; the developer and tester only see your spec.`;

export const DEVELOPER_INSTRUCTIONS = `You are a developer. Implement the single function described by the design spec as a self-contained TypeScript module.
Rules:
- Export the function exactly as the signature specifies.
- The module must have NO imports and NO external dependencies.
- Return the FULL module source in sourceCode, ready to write to a .ts file.
- If feedback from failing tests is provided, fix the implementation so those tests pass; do not change the public signature.`;

export const TESTER_INSTRUCTIONS = `You are a tester. Write a Vitest spec that thoroughly tests the given module.
Rules:
- Import { describe, it, expect } from "vitest".
- Import the function under test from the provided import path.
- Cover the behavior, the listed edge cases, and the examples.
- Output ONLY the test file source in testSource.`;

export function renderOrchestratorPrompt(prompt: string, maxItems: number): string {
  return `Request:\n${prompt}\n\nProduce at most ${maxItems} independent work items.`;
}

function renderDependencyContext(deps: DependencyContext): string[] {
  if (deps.length === 0) return [];
  return [
    "",
    `This item builds on already-completed building blocks. Their signatures (design only;`,
    `each is its own module — do not assume you can import them here):`,
    ...deps.map((d) => `- ${d.functionName}: ${d.signature} — ${d.behavior}`),
  ];
}

export function renderDesignerPrompt(input: DesignInput): string {
  const { item } = input;
  return [
    `Work item ${item.id}: ${item.title}`,
    `Description: ${item.description}`,
    `Acceptance criteria:`,
    ...item.acceptanceCriteria.map((c) => `- ${c}`),
    ...renderDependencyContext(input.dependencies),
  ].join("\n");
}

export function renderDeveloperPrompt(input: DevelopInput): string {
  const lines = [
    `Design spec for ${input.spec.functionName}:`,
    `Signature: ${input.spec.signature}`,
    `Behavior: ${input.spec.behavior}`,
    `Edge cases:`,
    ...input.spec.edgeCases.map((c) => `- ${c}`),
    `Examples:`,
    ...input.spec.examples.map((e) => `- ${e}`),
    ...renderDependencyContext(input.dependencies),
  ];
  if (input.feedback && input.previousCode) {
    lines.push(
      "",
      `This is rework attempt ${input.attempt}. Your previous code FAILED its tests.`,
      `Previous source:`,
      "```ts",
      input.previousCode,
      "```",
      `Failing-test feedback:`,
      input.feedback,
      "",
      `Fix the implementation so the tests pass. Keep the same exported signature.`,
    );
  }
  return lines.join("\n");
}

export function renderTesterPrompt(input: WriteTestsInput): string {
  const spec: DesignSpec = input.spec;
  return [
    `Write a Vitest spec for ${input.functionName}.`,
    `Import it from "${input.importPath}".`,
    `Signature: ${spec.signature}`,
    `Behavior: ${spec.behavior}`,
    `Edge cases:`,
    ...spec.edgeCases.map((c) => `- ${c}`),
    `Examples:`,
    ...spec.examples.map((e) => `- ${e}`),
    "",
    `Module under test:`,
    "```ts",
    input.sourceCode,
    "```",
  ].join("\n");
}
