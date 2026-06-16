/**
 * Deterministic, LLM-free agent bundle.
 *
 * Purpose:
 *  - The walking skeleton (and `--stub` runs) so the engine can be exercised
 *    end-to-end, with REAL test execution, without a gateway.
 *  - The test suite: every acceptance criterion about the engine (concurrency,
 *    rework loop, clean shutdown, serializable events) is verified against these.
 *
 * The stubs produce genuinely working `string_utils` implementations so the
 * sandbox actually passes. One function (`countVowels`) is wired to fail its
 * FIRST attempt and succeed on rework, so the dev<->tester back-edge is
 * observable in a deterministic run.
 */
import type {
  CodeOutput,
  DesignOutput,
  ReviewOutput,
  TestOutput,
  WbsOutput,
  WorkItem,
} from "../contracts.js";
import { SOURCE_IMPORT } from "../sandbox.js";
import type {
  Agents,
  DesignInput,
  DevelopInput,
  ReviewInput,
  WriteTestsInput,
} from "./types.js";

interface FnSpec {
  name: string;
  signature: string;
  behavior: string;
  edgeCases: string[];
  examples: string[];
  /** Correct implementation body (returned as a full module). */
  good: string;
  /** A deliberately wrong first attempt, to exercise the rework loop. */
  bad?: string;
  /** Vitest assertions body. */
  tests: string;
}

const FNS: Record<string, FnSpec> = {
  slugify: {
    name: "slugify",
    signature: "export function slugify(text: string): string",
    behavior: "Lowercase, trim, replace non-alphanumerics with single hyphens, no leading/trailing hyphens.",
    edgeCases: ["empty string", "leading/trailing spaces", "repeated separators"],
    examples: ['slugify("Hello World") -> "hello-world"'],
    good: `export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`,
    tests: `  expect(slugify("Hello World")).toBe("hello-world");
  expect(slugify("  Spaced  Out  ")).toBe("spaced-out");
  expect(slugify("a!!!b")).toBe("a-b");
  expect(slugify("")).toBe("");`,
  },
  truncateWords: {
    name: "truncateWords",
    signature: "export function truncateWords(text: string, n: number): string",
    behavior: "Return the first n words joined by single spaces; fewer words returns them all.",
    edgeCases: ["n <= 0", "n greater than word count", "extra whitespace"],
    examples: ['truncateWords("a b c d", 2) -> "a b"'],
    good: `export function truncateWords(text: string, n: number): string {
  if (n <= 0) return "";
  const words = text.trim().split(/\\s+/).filter(Boolean);
  return words.slice(0, n).join(" ");
}
`,
    tests: `  expect(truncateWords("a b c d", 2)).toBe("a b");
  expect(truncateWords("a b", 5)).toBe("a b");
  expect(truncateWords("a b c", 0)).toBe("");
  expect(truncateWords("  x   y ", 1)).toBe("x");`,
  },
  countVowels: {
    name: "countVowels",
    signature: "export function countVowels(text: string): number",
    behavior: "Count the vowels a, e, i, o, u case-insensitively.",
    edgeCases: ["uppercase vowels", "no vowels", "empty string"],
    examples: ['countVowels("Hello") -> 2'],
    // First attempt is case-sensitive (misses uppercase) -> fails its test.
    bad: `export function countVowels(text: string): number {
  return (text.match(/[aeiou]/g) ?? []).length;
}
`,
    good: `export function countVowels(text: string): number {
  return (text.match(/[aeiou]/gi) ?? []).length;
}
`,
    tests: `  expect(countVowels("Hello")).toBe(2);
  expect(countVowels("AEIOU")).toBe(5);
  expect(countVowels("xyz")).toBe(0);
  expect(countVowels("")).toBe(0);`,
  },
  isPalindrome: {
    name: "isPalindrome",
    signature: "export function isPalindrome(text: string): boolean",
    behavior: "True if the string reads the same forwards and backwards, ignoring case and non-alphanumerics.",
    edgeCases: ["mixed case", "punctuation/spaces", "empty string is a palindrome"],
    examples: ['isPalindrome("A man, a plan, a canal: Panama") -> true'],
    good: `export function isPalindrome(text: string): boolean {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === [...cleaned].reverse().join("");
}
`,
    tests: `  expect(isPalindrome("A man, a plan, a canal: Panama")).toBe(true);
  expect(isPalindrome("racecar")).toBe(true);
  expect(isPalindrome("hello")).toBe(false);
  expect(isPalindrome("")).toBe(true);`,
  },
  titleCase: {
    name: "titleCase",
    signature: "export function titleCase(text: string): string",
    behavior: "Capitalize the first letter of each whitespace-separated word, lowercasing the rest.",
    edgeCases: ["already capitalized", "extra spaces", "empty string"],
    examples: ['titleCase("hello world") -> "Hello World"'],
    good: `export function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(/(\\s+)/)
    .map((part) => (/\\s/.test(part) || part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join("");
}
`,
    tests: `  expect(titleCase("hello world")).toBe("Hello World");
  expect(titleCase("HELLO")).toBe("Hello");
  expect(titleCase("a b c")).toBe("A B C");
  expect(titleCase("")).toBe("");`,
  },
};

function fnForItem(item: { id: string; title: string }): FnSpec {
  // Items carry the function name in their title (set by the stub orchestrator).
  const key = Object.keys(FNS).find((k) => item.title.includes(k));
  return FNS[key ?? "slugify"]!;
}

export function createStubAgents(): Agents {
  return {
    async orchestrate(_prompt: string, maxItems: number): Promise<WbsOutput> {
      const items = Object.values(FNS)
        .slice(0, maxItems)
        .map((f) => ({
          title: `${f.name} utility`,
          description: `Implement ${f.signature}. ${f.behavior}`,
          acceptanceCriteria: f.edgeCases.map((e) => `Handle: ${e}`),
          dependsOn: [] as string[],
        }));
      return { items };
    },

    async design({ item }: DesignInput): Promise<DesignOutput> {
      const f = fnForItem(item);
      return {
        functionName: f.name,
        signature: f.signature,
        behavior: f.behavior,
        edgeCases: f.edgeCases,
        examples: f.examples,
      };
    },

    async develop(input: DevelopInput): Promise<CodeOutput> {
      const f = FNS[input.spec.functionName] ?? fnForItem({ id: "", title: input.spec.functionName });
      // First attempt of a function with a `bad` variant fails; rework uses `good`.
      const useBad = f.bad && input.attempt === 1 && input.feedback === null;
      return { functionName: f.name, sourceCode: useBad ? f.bad! : f.good };
    },

    async writeTests(input: WriteTestsInput): Promise<TestOutput> {
      const f = FNS[input.functionName] ?? fnForItem({ id: "", title: input.functionName });
      const testSource = `import { describe, it, expect } from "vitest";
import { ${f.name} } from "${SOURCE_IMPORT}";

describe("${f.name}", () => {
  it("meets the spec", () => {
${f.tests}
  });
});
`;
      return { testSource };
    },

    async review(input: ReviewInput): Promise<ReviewOutput> {
      // The deterministic critic approves any non-empty implementation that
      // exports the expected function. Rejection behaviour is exercised by a
      // dedicated test with a custom critic.
      const approved =
        input.sourceCode.includes(`export function ${input.spec.functionName}`) &&
        !input.sourceCode.includes("TODO");
      return { approved, notes: approved ? "" : "Implement the function fully (no TODOs)." };
    },
  };
}
