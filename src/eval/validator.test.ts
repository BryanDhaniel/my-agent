import { describe, it, expect } from "vitest";
import { runValidation } from "./validator.js";

describe("runValidation", () => {
  it("reports ok for a command that exits 0", async () => {
    const out = await runValidation("node -e \"process.exit(0)\"", process.cwd(), 10_000);
    expect(out.ok).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.timedOut).toBe(false);
  });

  it("reports failure for a non-zero exit", async () => {
    const out = await runValidation("node -e \"process.exit(3)\"", process.cwd(), 10_000);
    expect(out.ok).toBe(false);
    expect(out.exitCode).toBe(3);
  });

  it("times out a long-running command", async () => {
    const out = await runValidation("node -e \"setTimeout(()=>{}, 5000)\"", process.cwd(), 300);
    expect(out.timedOut).toBe(true);
    expect(out.ok).toBe(false);
  });

  it("handles a command that cannot be spawned", async () => {
    const out = await runValidation("this-command-does-not-exist-xyz", process.cwd(), 5_000);
    expect(out.ok).toBe(false);
    // With shell:true the missing command makes the shell exit non-zero (1/127);
    // a genuine spawn failure (shell itself unlaunchable) yields -1.
    expect([1, 127, -1]).toContain(out.exitCode);
  });
});
