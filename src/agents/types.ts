/**
 * The agent bundle the engine consumes. The engine depends only on this
 * interface — never on Mastra, the LLM, or any concrete implementation — so it
 * can be driven by deterministic stubs in tests and the walking skeleton, and by
 * real Mastra/LLM agents at the CLI boundary.
 */
import type {
  CodeOutput,
  DesignOutput,
  DesignSpec,
  TestOutput,
  WbsOutput,
  WorkItem,
} from "../contracts.js";

/** Design specs of the items this one depends on (already designed & passed),
 * provided as building-block context. Empty for DAG roots. */
export type DependencyContext = DesignSpec[];

export interface DesignInput {
  item: WorkItem;
  dependencies: DependencyContext;
}

export interface DevelopInput {
  spec: DesignSpec;
  dependencies: DependencyContext;
  /** Present only on rework: the previous attempt's source + failing-test feedback. */
  previousCode: string | null;
  feedback: string | null;
  attempt: number;
}

export interface WriteTestsInput {
  spec: DesignSpec;
  functionName: string;
  sourceCode: string;
  /** The import specifier the spec must use to reach the module under test. */
  importPath: string;
}

export interface Agents {
  orchestrate(prompt: string, maxItems: number): Promise<WbsOutput>;
  design(input: DesignInput): Promise<DesignOutput>;
  develop(input: DevelopInput): Promise<CodeOutput>;
  writeTests(input: WriteTestsInput): Promise<TestOutput>;
}
