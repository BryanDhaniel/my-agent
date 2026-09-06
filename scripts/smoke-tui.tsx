/**
 * TUI smoke check: renders the real <App> against a MockProvider, simulates
 * typing, and asserts the conversation surface still drives a full turn.
 *
 * Unlike `smoke:agent` this needs no API key and no network. It exists to
 * prove the Ink layer still works after changes to the harness/event contract.
 *
 * Run: npm run smoke:tui
 */
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHarness } from "../src/harness/harness.js";
import { ToolRegistry } from "../src/agent/registry.js";
import { AutoApproveGate, NOOP_UI_GATE } from "../src/permissions/gate.js";
import { SessionStore } from "../src/session/store.js";
import { SkillRegistry } from "../src/skills/index.js";
import { App } from "../src/ui/app.js";
import type { Provider, StreamEvent } from "../src/providers/provider.js";
import type { ChatMessage } from "../src/agent/types.js";

class MockProvider implements Provider {
  readonly name = "mock";
  readonly model = "mock-model";
  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    void messages;
    yield { type: "text-delta", delta: "Noted. I will keep using pnpm." };
    yield {
      type: "done",
      message: { role: "assistant", content: "Noted. I will keep using pnpm." },
    };
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "tui-smoke-"));
  const store = new SessionStore(tmpDir);

  // A registered skill, so /skills has something real to list.
  const skills = new SkillRegistry();
  skills.registerAll([
    {
      name: "review-pr",
      description: "Review a pull request.",
      invocation: "user" as const,
      source: "skills/review-pr",
      instructions: "review the diff",
    },
  ]);

  const harness = await AgentHarness.create(new MockProvider(), {
    store,
    registry: new ToolRegistry(),
    gate: new AutoApproveGate(),
    cwd: tmpDir,
    skills,
  });

  // Seed a memory so the "memory-recalled" event fires on the first turn.
  await harness.memory.store({
    content: "This project uses pnpm as its package manager",
    category: "project",
    source: "seed",
  });

  const stdout = new PassThrough();
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  // Ink's useInput() bails unless stdin looks like a TTY: it calls
  // setRawMode / ref / unref, and v6 pulls bytes with stdin.read().
  const fake = stdin as unknown as Record<string, unknown>;
  fake["isTTY"] = true;
  fake["setRawMode"] = () => stdin;
  fake["ref"] = () => stdin;
  fake["unref"] = () => stdin;
  fake["readable"] = true;

  let out = "";
  stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });

  const inst = render(
    <App service={harness as any} gate={NOOP_UI_GATE} store={store} />,
    { stdout: stdout as any, stdin, patchConsole: false, debug: true },
  );

  await sleep(300);
  stdin.write("we should keep using pnpm for this repo");
  await sleep(200);
  stdin.write("\r");
  await sleep(1500);

  // /skills must render registered skills as a readable panel. Regression
  // guard for "commands print nothing you can actually see".
  stdin.write("/skills");
  await sleep(300);
  stdin.write("\r");
  await sleep(900);

  // "/" alone, arrow down to a command, enter: must run the highlighted
  // command rather than sending "/" to the model. Suggestion order is
  // help, new, session, skills, exit, so one arrow down lands on /new.
  stdin.write("/");
  await sleep(400);
  stdin.write(String.fromCharCode(27) + "[B"); // down arrow
  await sleep(400);
  stdin.write("\r");
  await sleep(1000);

  inst.unmount();
  await sleep(200);

  const plain = out.replace(/\[[0-9;]*m/g, "");
  console.log("========== RENDERED ==========");
  console.log(plain);

  const checks: Array<[string, boolean]> = [
    ["header/brand rendered", /my-agent/.test(plain)],
    ["prompt input rendered", /Ask a question/.test(plain)],
    ["user message echoed", /we should keep using pnpm/.test(plain)],
    ["assistant reply rendered", /keep using pnpm/i.test(plain)],
    ["memory-recalled notice", /recalled\s*\d+\s*memor/i.test(plain)],
    ["memory-stored notice", /saved\s*\d+\s*memor/i.test(plain)],
    ["skills panel title", /Skills \(\d+\)/.test(plain)],
    ["skills panel lists the skill", /review-pr/.test(plain)],
    ["skills panel shows description", /Review a pull request/.test(plain)],
    ["session footer rendered", /session\s+\S+/.test(plain)],
    ["footer shows skill count", /\d+ skills/.test(plain)],
    ["slash + arrow + enter runs the command", /started new session/.test(plain)],
  ];

  console.log("========== CHECKS ==========");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }

  await rm(tmpDir, { recursive: true, force: true });
  console.log(ok ? "TUI smoke ok" : "TUI smoke failed");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke error", err);
  process.exit(1);
});
