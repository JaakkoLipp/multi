/**
 * Interactive setup: configure the LLM gateway and the GitHub App, optionally
 * test both connections, and write the values to `.env` (merging — existing keys
 * and comments are preserved).
 *
 *   npm run setup            # interactive
 *   npm run setup -- --check # just test the current .env, no prompts
 *
 * Pure file logic lives in src/setup/env-file.ts (unit-tested); the connection
 * tests live in src/setup/checks.ts (the real code paths the app uses).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, type RawEnv } from "../src/config.js";
import { checkGitHubConnection, checkLlmConnection } from "../src/setup/checks.js";
import { parseEnvText, updateEnvText } from "../src/setup/env-file.js";

const ENV_PATH = path.resolve(".env");

async function readExistingEnv(): Promise<{ text: string; values: Map<string, string> }> {
  try {
    const text = await readFile(ENV_PATH, "utf8");
    return { text, values: parseEnvText(text) };
  } catch {
    // Seed from .env.example if present, so comments/structure carry over.
    try {
      const example = await readFile(path.resolve(".env.example"), "utf8");
      return { text: example, values: parseEnvText(example) };
    } catch {
      return { text: "", values: new Map() };
    }
  }
}

function envFromValues(values: Map<string, string>): RawEnv {
  return Object.fromEntries(values);
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const { text: existingText, values } = await readExistingEnv();

  if (checkOnly) {
    await runChecks(envFromValues(values), { llm: true, github: true });
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const updates: Record<string, string> = {};
  const ask = async (q: string, def?: string): Promise<string> => {
    const suffix = def ? ` [${def}]` : "";
    const a = (await rl.question(`${q}${suffix}: `)).trim();
    return a === "" ? (def ?? "") : a;
  };
  const yes = async (q: string, defYes = false): Promise<boolean> => {
    const a = (await rl.question(`${q} (${defYes ? "Y/n" : "y/N"}) `)).trim().toLowerCase();
    return a === "" ? defYes : a.startsWith("y");
  };

  try {
    console.log("\n=== LLM (OpenAI-compatible gateway) ===");
    updates.LITELLM_BASE_URL = await ask("Base URL", values.get("LITELLM_BASE_URL") ?? "http://localhost:11434/v1");
    updates.LITELLM_API_KEY = await ask("API key", values.get("LITELLM_API_KEY") ?? "sk-local");

    if (await yes("Use one model id for every stage?", true)) {
      const m = await ask("Model id", values.get("DEVELOPER_MODEL") ?? "qwen2.5-coder");
      updates.ORCHESTRATOR_MODEL = m;
      updates.DESIGNER_MODEL = m;
      updates.DEVELOPER_MODEL = m;
      updates.TESTER_MODEL = m;
      updates.REVIEWER_MODEL = m;
    } else {
      updates.ORCHESTRATOR_MODEL = await ask("Orchestrator model", values.get("ORCHESTRATOR_MODEL"));
      updates.DESIGNER_MODEL = await ask("Designer model", values.get("DESIGNER_MODEL"));
      updates.DEVELOPER_MODEL = await ask("Developer model", values.get("DEVELOPER_MODEL"));
      updates.TESTER_MODEL = await ask("Tester model", values.get("TESTER_MODEL"));
      updates.REVIEWER_MODEL = await ask("Reviewer model", values.get("REVIEWER_MODEL"));
    }

    if (await yes("Test the LLM connection now?", true)) {
      await runChecks(envFromValues(new Map([...values, ...Object.entries(updates)])), { llm: true, github: false });
    }

    console.log("\n=== GitHub App (optional — for issue/PR ownership) ===");
    if (await yes("Configure a GitHub App?", false)) {
      updates.GITHUB_APP_ID = await ask("App ID", values.get("GITHUB_APP_ID"));
      const pemPath = await ask("Path to the App private key (.pem file)", "");
      if (pemPath) {
        try {
          updates.GITHUB_PRIVATE_KEY = await readFile(path.resolve(pemPath), "utf8");
        } catch (err) {
          console.error(`  ! Could not read ${pemPath}: ${(err as Error).message}`);
        }
      }
      updates.GITHUB_INSTALLATION_ID = await ask("Installation ID", values.get("GITHUB_INSTALLATION_ID"));
      updates.GITHUB_OWNER = await ask("Repo owner", values.get("GITHUB_OWNER"));
      updates.GITHUB_REPO = await ask("Repo name", values.get("GITHUB_REPO"));

      if (await yes("Test the GitHub connection now?", true)) {
        await runChecks(envFromValues(new Map([...values, ...Object.entries(updates)])), { llm: false, github: true });
      }
    }

    console.log("\n=== Repo mode (optional) ===");
    if (await yes("Set repo-mode commands (for editing an existing repo)?", false)) {
      updates.REPO_SETUP_CMD = await ask("Setup command (e.g. npm ci)", values.get("REPO_SETUP_CMD") ?? "npm ci");
      updates.REPO_TEST_CMD = await ask("Test command", values.get("REPO_TEST_CMD") ?? "npm test");
    }

    const next = updateEnvText(existingText, updates);
    if (await yes(`\nWrite these settings to ${ENV_PATH}?`, true)) {
      await writeFile(ENV_PATH, next.endsWith("\n") ? next : next + "\n", "utf8");
      console.log(`✓ Wrote ${ENV_PATH}`);
      console.log("\nNext: a module run with your model →");
      console.log('  npx tsx src/cli.ts "Build a string_utils module with slugify and countVowels"');
    } else {
      console.log("Aborted — nothing written.");
    }
  } finally {
    rl.close();
  }
}

async function runChecks(env: RawEnv, which: { llm: boolean; github: boolean }): Promise<void> {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    console.error(`  ! Config invalid: ${(err as Error).message}`);
    return;
  }
  if (which.llm) {
    process.stdout.write("  • LLM … ");
    const r = await checkLlmConnection(config);
    console.log(r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`);
  }
  if (which.github) {
    process.stdout.write("  • GitHub … ");
    const r = await checkGitHubConnection(config);
    console.log(r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
