/**
 * Pure .env read/merge/write helpers used by the interactive setup script.
 *
 * Kept separate from the (interactive, untestable) prompt flow so the file-format
 * logic — parsing, value quoting, and in-place key updates that PRESERVE existing
 * comments/structure — is unit-tested.
 */

/** Parse `KEY=value` lines (ignoring comments/blanks) into a map. */
export function parseEnvText(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const rest = line.slice(eq + 1).replace(/^\s+/, "");
    let value: string;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0]!;
      const end = rest.indexOf(quote, 1);
      const inner = end === -1 ? rest.slice(1) : rest.slice(1, end);
      value = inner.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      // Unquoted: a `#` at the start or preceded by whitespace begins a comment.
      let cut = rest.length;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "#" && (i === 0 || /\s/.test(rest[i - 1]!))) {
          cut = i;
          break;
        }
      }
      value = rest.slice(0, cut).trim();
    }
    map.set(key, value);
  }
  return map;
}

/** Serialize a value, quoting + escaping when it contains whitespace/specials. */
export function serializeEnvValue(value: string): string {
  if (value === "") return "";
  if (/[\s#"'\\]/.test(value) || value.includes("\n")) {
    const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Apply `updates` to `existing` .env text: replace the value of any key that
 * already has a line (preserving order + comments), and append the rest at the
 * end. An empty `existing` yields a fresh file.
 */
export function updateEnvText(existing: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = existing === "" ? [] : existing.split("\n");

  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${serializeEnvValue(value)}`;
    }
    return line;
  });

  if (remaining.size > 0) {
    if (out.length > 0 && out[out.length - 1]!.trim() !== "") out.push("");
    for (const [key, value] of remaining) out.push(`${key}=${serializeEnvValue(value)}`);
  }

  return out.join("\n");
}
