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
import { MemoryCredentialStore } from "../src/credentials/index.js";
import { ProviderManager } from "../src/providers/manager.js";

class MockProvider implements Provider {
  readonly name = "mock";
  readonly model = "mock-model";
  /** Everything the model was actually asked, so tests can prove a slash
   *  command was handled locally instead of being forwarded. */
  readonly seen: string[] = [];
  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
    this.seen.push(
      messages
        .filter((m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user")
        .map((m) => m.content)
        .join("\n"),
    );
    yield { type: "text-delta", delta: "Noted. I will keep using pnpm." };
    yield {
      type: "done",
      message: { role: "assistant", content: "Noted. I will keep using pnpm." },
    };
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Poll the captured stdout until a regex matches (or timeout). The first
 *  turn can outlast a fixed sleep when memory is seeded, so waiting on the
 *  actual rendered text is far less flaky than guessing a duration. */
const waitFor = async (
  getOut: () => string,
  re: RegExp,
  timeoutMs = 6000,
): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (re.test(getOut().replace(/\[[0-9;]*m/g, ""))) return true;
    await sleep(50);
  }
  return false;
};

/**
 * Wait until a turn has fully settled: the expected reply is on screen AND
 * the "Thinking…" indicator is gone (busy=false, so the prompt is mounted and
 * ready to accept the next keystroke). Waiting only on the reply text returns
 * mid-stream, while the input is still unmounted — keystrokes sent then pile
 * into one buffer and get submitted together.
 */
const waitIdleFor = async (
  getOut: () => string,
  replyRe: RegExp,
  timeoutMs = 8000,
): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const plain = getOut().replace(/\[[0-9;]*m/g, "");
    if (replyRe.test(plain) && !/Thinking/.test(plain)) return true;
    await sleep(50);
  }
  return false;
};

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

  const mock = new MockProvider();
  const harness = await AgentHarness.create(mock, {
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
  let outAfterSkills = "";
  stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });

  // Empty credential store and no environment, so provider status is
  // deterministic regardless of the machine running the smoke check.
  const providers = new ProviderManager({
    credentials: new MemoryCredentialStore(),
    persist: false,
    env: {},
  });
  await providers.init();

  const inst = render(
    <App
      service={harness as any}
      gate={NOOP_UI_GATE}
      store={store}
      providers={providers}
    />,
    { stdout: stdout as any, stdin, patchConsole: false, debug: true },
  );

  await sleep(300);
  stdin.write("we should keep using pnpm for this repo");
  await sleep(200);
  stdin.write("\r");
  // Wait for the assistant turn to actually finish (busy=false, prompt
  // mounted) before driving more keys. Match the assistant's reply ("Noted."),
  // NOT the typed prompt text — the prompt text also contains "keep using
  // pnpm", so matching it would return before the turn even starts.
  await waitIdleFor(() => out, /Noted\./);

  // /skills must render registered skills as a readable panel. Regression
  // guard for "commands print nothing you can actually see".
  stdin.write("/skills");
  await sleep(300);
  stdin.write("\r");
  // Snapshot now: a later /new wipes the transcript, so the panel would be
  // gone from the final render. Capture it once it is actually on screen.
  await waitFor(() => out, /Skills \(\d+\)/);
  outAfterSkills = out;

  // /provider must open a local picker and never reach the model.
  stdin.write("/provider");
  await sleep(400);
  stdin.write("\r");
  await sleep(700);

  // "/model" with nothing configured: still a local picker, still no LLM call.
  stdin.write(String.fromCharCode(27)); // esc, close the provider picker
  await sleep(300);
  stdin.write("/model");
  await sleep(400);
  stdin.write("\r");
  await sleep(700);
  stdin.write(String.fromCharCode(27)); // esc, close the model picker
  await sleep(300);

  // "/" alone, arrow down to a command, enter: must run the highlighted
  // command rather than sending "/" to the model. Suggestion order is
  // help, new, session, skills, exit, so one arrow down lands on /new.
  stdin.write("/");
  await sleep(400);
  stdin.write(String.fromCharCode(27) + "[B"); // down arrow
  await sleep(400);
  stdin.write("\r");
  await sleep(1000);

  // Close whatever picker is open before unmounting.
  stdin.write(String.fromCharCode(27));
  await sleep(300);

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
    ["skills panel title", /Skills \(\d+\)/.test(outAfterSkills)],
    ["skills panel lists the skill", /review-pr/.test(plain)],
    ["skills panel shows description", /Review a pull request/.test(plain)],
    ["session footer rendered", /session\s+\S+/.test(plain)],
    ["footer shows skill count", /\d+ skills/.test(plain)],
    ["slash + arrow + enter runs the command", /started new session/.test(plain)],
    ["/provider opens a picker", /Select Provider/.test(plain)],
    ["/provider lists providers", /OpenAI/.test(plain) && /Gemini/.test(plain) && /GLM/.test(plain)],
    ["/provider shows configuration state", /not configured/.test(plain)],
    ["/model opens a local picker", /Select model/.test(plain)],
    [
      "/provider never reached the model",
      !mock.seen.some((text) => text.includes("/provider")),
    ],
    ["/model never reached the model", !mock.seen.some((text) => text.includes("/model"))],
    ["/skills handled locally", !mock.seen.some((text) => text.includes("/skills"))],
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
