/**
 * TUI smoke check: renders the real <App> against a MockProvider, simulates
 * typing, and asserts the conversation surface still drives a full turn.
 *
 * Unlike `smoke:agent` this needs no API key and no network — it exists to
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
import { App } from "../src/ui/app.js";
import type { Provider, StreamEvent } from "../src/providers/provider.js";
import type { ChatMessage } from "../src/agent/types.js";

class MockProvider implements Provider {
  readonly name = "mock";
  readonly model = "mock-model";
  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    void messages;
    yield { type: "text-delta", delta: "Noted — I'll keep using pnpm." };
    yield {
      type: "done",
      message: { role: "assistant", content: "Noted — I'll keep using pnpm." },
    };
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "tui-smoke-"));
  const store = new SessionStore(tmpDir);
  const harness = await AgentHarness.create(new MockProvider(), {
    store,
    registry: new ToolRegistry(),
    gate: new AutoApproveGate(),
    cwd: tmpDir,
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

  inst.unmount();
  await sleep(200);

  const plain = out.replace(/\[[0-9;]*m/g, "");
  console.log("========== RENDERED ==========");
  console.log(plain);

  const checks: Array<[string, boolean]> = [
    ["header/brand rendered", /my-agent/.test(plain)],
    ["prompt input rendered", /Type a message/.test(plain)],
    ["user message echoed", /we should keep using pnpm/.test(plain)],
    ["assistant reply rendered", /keep using pnpm/i.test(plain)],
    ["memory-recalled notice", /recalled\s*\d+\s*memor/i.test(plain)],
    ["memory-stored notice", /saved\s*\d+\s*memor/i.test(plain)],
    ["session footer rendered", /session\s+\S+/.test(plain)],
  ];

  console.log("========== CHECKS ==========");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }

  await rm(tmpDir, { recursive: true, force: true });
  console.log(ok ? "✓ TUI smoke ok" : "✗ TUI smoke failed");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
