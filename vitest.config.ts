import { defineConfig } from "vitest/config";

// Keep vitest focused on the TypeScript unit/integration suite. The evaluation
// task fixtures (evals/tasks/** and src/eval/test/fixtures/**) contain
// `*.test.mjs` files meant for `node --test` (run by the eval validator), NOT
// for vitest — otherwise vitest tries to execute them as suites and fails with
// "No test suite found".
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/evals/**",
      "**/test/fixtures/**",
    ],
  },
});
