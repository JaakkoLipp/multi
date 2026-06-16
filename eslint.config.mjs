// Flat ESLint config used as the pipeline's "lint" quality gate against the
// model-generated module. Parser-only (no type-aware rules) so it can lint a
// standalone file fast, with a small set of correctness/style rules. This is
// NOT the linter for the project's own source — it is applied to generated code
// inside the sandbox via `lintModule()`.
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
      "no-debugger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
    },
  },
];
