/**
 * The setup script's pure .env logic: parsing, value quoting/escaping (esp. a
 * multi-line PEM key), and in-place key updates that preserve comments + order.
 */
import { describe, expect, it } from "vitest";
import { parseEnvText, serializeEnvValue, updateEnvText } from "../src/setup/env-file.js";

describe("parseEnvText", () => {
  it("parses keys, ignores comments/blanks, unquotes values", () => {
    const m = parseEnvText(['# a comment', '', 'FOO=bar', 'URL=http://x/v1', 'Q="has space"'].join("\n"));
    expect(m.get("FOO")).toBe("bar");
    expect(m.get("URL")).toBe("http://x/v1");
    expect(m.get("Q")).toBe("has space");
    expect(m.has("# a comment")).toBe(false);
  });
  it("round-trips an escaped multi-line value", () => {
    const m = parseEnvText('KEY="line1\\nline2"');
    expect(m.get("KEY")).toBe("line1\nline2");
  });
  it("strips inline comments on unquoted values (as in .env.example)", () => {
    const m = parseEnvText(
      ["DEVELOPER_MODEL=qwen2.5-coder      # a local coder model", "GITHUB_INSTALLATION_ID=    # the id", "URL=http://x/v1"].join("\n"),
    );
    expect(m.get("DEVELOPER_MODEL")).toBe("qwen2.5-coder");
    expect(m.get("GITHUB_INSTALLATION_ID")).toBe(""); // empty + comment -> empty
    expect(m.get("URL")).toBe("http://x/v1"); // // is not a comment
  });
});

describe("serializeEnvValue", () => {
  it("leaves simple values bare and quotes/escapes complex ones", () => {
    expect(serializeEnvValue("simple")).toBe("simple");
    expect(serializeEnvValue("has space")).toBe('"has space"');
    expect(serializeEnvValue("-----BEGIN-----\nkey\n-----END-----")).toBe('"-----BEGIN-----\\nkey\\n-----END-----"');
  });
});

describe("updateEnvText", () => {
  it("updates existing keys in place and preserves comments + order", () => {
    const existing = ["# LLM", "LITELLM_BASE_URL=http://old/v1", "LITELLM_API_KEY=old", "", "# misc", "MAX_WBS_ITEMS=6"].join("\n");
    const out = updateEnvText(existing, { LITELLM_BASE_URL: "http://new/v1", LITELLM_API_KEY: "sk-new" });
    expect(out).toContain("# LLM");
    expect(out).toContain("LITELLM_BASE_URL=http://new/v1");
    expect(out).toContain("LITELLM_API_KEY=sk-new");
    expect(out).toContain("MAX_WBS_ITEMS=6"); // untouched
    // No duplicate keys.
    expect(out.match(/LITELLM_BASE_URL=/g)).toHaveLength(1);
  });
  it("appends new keys, quoting a multi-line PEM", () => {
    const out = updateEnvText("FOO=bar", { GITHUB_PRIVATE_KEY: "-----BEGIN-----\nabc\n-----END-----" });
    expect(out).toContain("FOO=bar");
    expect(out).toContain('GITHUB_PRIVATE_KEY="-----BEGIN-----\\nabc\\n-----END-----"');
    // The written key, parsed back, restores the real newlines.
    expect(parseEnvText(out).get("GITHUB_PRIVATE_KEY")).toBe("-----BEGIN-----\nabc\n-----END-----");
  });
  it("writes a fresh file from empty", () => {
    const out = updateEnvText("", { A: "1", B: "two words" });
    expect(parseEnvText(out).get("A")).toBe("1");
    expect(parseEnvText(out).get("B")).toBe("two words");
  });
});
