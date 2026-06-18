/**
 * Connection self-tests for the setup script — validate the LLM gateway and the
 * GitHub App credentials BEFORE a real run, using the exact code paths the app
 * uses (so a green check means the app will actually work).
 *
 * Real/network operations, lazily imported so a normal CLI run never loads them.
 */
import { z } from "zod";
import type { PipelineConfig } from "../config.js";

export interface CheckResult {
  ok: boolean;
  detail: string;
}

/** One structured-output round-trip against the configured model (the real path). */
export async function checkLlmConnection(config: PipelineConfig, model?: string): Promise<CheckResult> {
  try {
    const { createLlm } = await import("../llm.js");
    const llm = createLlm(config);
    const schema = z.object({ ok: z.boolean(), word: z.string() });
    const out = await llm.generateStructured({
      model: model ?? config.models.developer,
      schema,
      system: "You are a JSON API. Reply only with the requested JSON object.",
      prompt: 'Return exactly this object: {"ok": true, "word": "pong"}.',
    });
    if (out.ok === true) {
      return { ok: true, detail: `structured output works (got ${JSON.stringify(out)})` };
    }
    return { ok: false, detail: `model responded but not as expected: ${JSON.stringify(out)}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/** Mint an installation token (proves appId + private key + installation are valid). */
export async function checkGitHubConnection(config: PipelineConfig): Promise<CheckResult> {
  try {
    const { createGitHubAppClient } = await import("../github/auth.js");
    const client = await createGitHubAppClient(config.github);
    const token = await client.installationToken();
    if (!token) return { ok: false, detail: "no installation token returned" };
    const where =
      config.github.owner && config.github.repo
        ? ` for ${config.github.owner}/${config.github.repo}`
        : "";
    return { ok: true, detail: `installation token minted${where} (…${token.slice(-6)})` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
