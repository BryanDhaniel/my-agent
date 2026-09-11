import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  AskUserGate,
  ModeGate,
  nextPermissionMode,
  type PermissionRequest,
  type PermissionResponse,
} from "./gate.js";

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    toolName: overrides.toolName ?? "run_bash",
    summary: overrides.summary ?? "run `npm test`",
    ruleKey: overrides.ruleKey,
  };
}

/**
 * Answers every pending request with `answer` and records which request ids
 * were actually prompted. Registered once, stays attached for the whole test.
 */
function autoRespond(gate: AskUserGate, answer: PermissionResponse): { promptedIds: Set<string> } {
  const promptedIds = new Set<string>();
  gate.onPendingChange((pending) => {
    for (const p of pending) promptedIds.add(p.id);
    const current = pending[0];
    if (current) setImmediate(() => gate.respond(current.id, answer));
  });
  return { promptedIds };
}

describe("AskUserGate session allowlist", () => {
  it("prompts again for 'once' approvals", async () => {
    const gate = new AskUserGate();
    const { promptedIds } = autoRespond(gate, "once");

    const first = await gate.check(request({ id: "r1", ruleKey: "npm" }));
    assert.ok(first.allowed);

    const second = await gate.check(request({ id: "r2", ruleKey: "npm" }));
    assert.ok(second.allowed);
    assert.deepEqual([...promptedIds].sort(), ["r1", "r2"]); // asked twice
    assert.equal(gate.allowedRules.length, 0); // nothing remembered
  });

  it("'always' short-circuits later calls with the same rule key", async () => {
    const gate = new AskUserGate();
    const { promptedIds } = autoRespond(gate, "always");

    const first = await gate.check(request({ id: "r1", toolName: "run_bash", ruleKey: "npm" }));
    assert.ok(first.allowed);
    assert.deepEqual([...gate.allowedRules], ["npm"]);

    const second = await gate.check(request({ id: "r2", toolName: "run_bash", ruleKey: "npm" }));
    assert.ok(second.allowed);
    assert.ok(!promptedIds.has("r2")); // allowlisted, never prompted
  });

  it("keys are per tool and per value", async () => {
    const gate = new AskUserGate();
    const { promptedIds } = autoRespond(gate, "always");

    await gate.check(request({ id: "r1", toolName: "run_bash", ruleKey: "npm" }));
    await gate.check(request({ id: "r2", toolName: "write_file", ruleKey: "src/" }));
    await gate.check(request({ id: "r3", toolName: "run_bash", ruleKey: "git" }));

    assert.equal(gate.allowedRules.length, 3); // every distinct key prompted+stored
    assert.ok(promptedIds.has("r3"));

    const repeat = await gate.check(request({ id: "r4", toolName: "run_bash", ruleKey: "npm" }));
    assert.ok(repeat.allowed);
    assert.ok(!promptedIds.has("r4"));
  });

  it("requests without a rule key can never be allowlisted", async () => {
    const gate = new AskUserGate();
    const { promptedIds } = autoRespond(gate, "always");

    await gate.check(request({ id: "r1", ruleKey: undefined }));
    await gate.check(request({ id: "r2", ruleKey: undefined }));

    assert.equal(gate.allowedRules.length, 0);
    assert.deepEqual([...promptedIds].sort(), ["r1", "r2"]);
  });
});

describe("nextPermissionMode", () => {
  it("cycles auto -> manual -> plan -> auto", () => {
    assert.equal(nextPermissionMode("auto"), "manual");
    assert.equal(nextPermissionMode("manual"), "plan");
    assert.equal(nextPermissionMode("plan"), "auto");
  });
});

describe("ModeGate (shift+tab permission modes)", () => {
  it("auto-approves every call in auto mode without prompting", async () => {
    const gate = new ModeGate("auto");
    let prompted = false;
    gate.onPendingChange(() => {
      prompted = true;
    });
    const decision = await gate.check(request());
    assert.ok(decision.allowed);
    assert.equal(prompted, false);
  });

  it("asks in manual mode, delegating to the inner AskUserGate", async () => {
    const gate = new ModeGate("manual");
    let prompted = false;
    gate.onPendingChange((pending) => {
      if (pending[0]) {
        prompted = true;
        setImmediate(() => gate.respond(pending[0]!.id, "once"));
      }
    });
    const decision = await gate.check(request({ id: "r1" }));
    assert.ok(decision.allowed);
    assert.equal(prompted, true);
  });

  it("denies mutations in plan mode and tells the agent to plan", async () => {
    const gate = new ModeGate("plan");
    const decision = await gate.check(request());
    assert.equal(decision.allowed, false);
    assert.match((decision as { reason: string }).reason, /plan mode/i);
  });

  it("switching modes changes behaviour live", async () => {
    const gate = new ModeGate("auto");
    assert.ok((await gate.check(request())).allowed);

    gate.setMode("plan");
    assert.equal((await gate.check(request())).allowed, false);

    gate.setMode("manual");
    let prompted = false;
    gate.onPendingChange((pending) => {
      if (pending[0]) {
        prompted = true;
        setImmediate(() => gate.respond(pending[0]!.id, "deny"));
      }
    });
    const denied = await gate.check(request({ id: "r9" }));
    assert.equal(denied.allowed, false);
    assert.equal(prompted, true);
  });

  it("forwards the session allowlist from the inner gate", async () => {
    const gate = new ModeGate("manual");
    gate.onPendingChange((pending) => {
      if (pending[0]) setImmediate(() => gate.respond(pending[0]!.id, "always"));
    });
    await gate.check(request({ id: "r1", ruleKey: "npm" }));
    assert.deepEqual([...gate.allowedRules], ["npm"]);
  });
});
