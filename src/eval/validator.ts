import { spawn } from "node:child_process";

/**
 * Run a task's validation command in the isolated fixture directory.
 *
 * Exit code 0 ⇒ pass. A genuine spawn failure (the shell itself cannot be
 * launched) yields exit code -1 via the `error` event. When a shell IS launched
 * but the inner command is missing, the shell exits non-zero (1/127) — that is a
 * normal `ok: false`, not a spawn error. A timeout kills the shell and reports
 * `timedOut`. Output is not captured — only the exit status matters for
 * pass/fail, keeping validation deterministic.
 *
 * Resolution happens on the `exit` event (not `close`): a SIGKILL'd shell can
 * leave the spawned child holding the stdio pipe open, which delays `close` and
 * would make the timeout test itself time out instead of resolving promptly.
 */
export interface ValidationOutcome {
  exitCode: number;
  ok: boolean;
  timedOut: boolean;
  error?: string;
}

export function runValidation(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ValidationOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      // A shell is required so `node --test` / `npm test` resolve cross-platform.
      shell: true,
      env: { ...process.env, CI: "true", NO_COLOR: "1" },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, ok: false, timedOut: false, error: err.message });
    });

    child.on("exit", (code, _signal) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      resolve({
        exitCode,
        ok: exitCode === 0 && !timedOut,
        timedOut,
        ...(timedOut ? { error: `validation timed out after ${timeoutMs}ms` } : {}),
        ...(!timedOut && exitCode !== 0 && stderr.trim() !== ""
          ? { error: stderr.trim().split("\n").slice(-3).join("\n") }
          : {}),
      });
    });
  });
}
