import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { ChatService } from "./chat.js";
import type { ChatEvent } from "./chat.js";
import type { AssistantMessage } from "./types.js";
import { ToolRegistry } from "./registry.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import {
  AutoApproveGate,
  DenyAllGate,
} from "../permissions/gate.js";
import { SessionStore } from "../session/store.js";
import type { Provider, StreamEvent } from "../providers/provider.js";

class FakeProvider implements Provider {
  readonly name = "fake";
  readonly model = "fake-1";
  #script: AssistantMessage[];

  constructor(script: AssistantMessage[]) {
    this.#script = [...script];
  }

  async *stream(): AsyncGenerator<StreamEvent> {
    const next = this.#script.shift();
    if (!next) throw new Error("script exhausted");
    yield { type: "done", message: next };
  }
}

async function makeService(
  script: AssistantMessage[],
  gate: AutoApproveGate | DenyAllGate,
): Promise<{ service: ChatService; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "my-agent-loop-"));
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  const store = new SessionStore(path.join(dir, "sessions"));
  const service = await ChatService.start(new FakeProvider(script), store, registry, gate, {
    cwd: dir,
  });
  return { service, dir };
}

async function collect(events: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("ChatService agent loop", () => {
  it("executes a requested tool call and feeds the result back", async () => {
    const { service, dir } = await makeService(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) },
          ],
        },
        { role: "assistant", content: "final answer" },
      ],
      new AutoApproveGate(),
    );
    await writeFile(path.join(dir, "hello.txt"), "disk says hi");

    const events = await collect(service.send("what does hello.txt say?"));

    const kinds = events.map((e) => e.type);
    assert.ok(kinds.includes("tool-start"));
    assert.ok(kinds.includes("tool-result"));

    const toolResult = events.find((e) => e.type === "tool-result");
    assert.ok(toolResult && toolResult.type === "tool-result");
    assert.match(toolResult.output, /disk says hi/);

    // the tool result was persisted into history before the final answer
    const roles = service.messages.map((m) => m.role);
    assert.deepEqual(roles.slice(-3), ["assistant", "tool", "assistant"]);
  });

  it("denies mutating tools through the permission gate", async () => {
    const { service } = await makeService(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-2",
              name: "write_file",
              arguments: JSON.stringify({ path: "evil.txt", content: "nope" }),
            },
          ],
        },
        { role: "assistant", content: "ok, I won't" },
      ],
      new DenyAllGate(),
    );

    const events = await collect(service.send("write evil.txt"));

    const denied = events.find((e) => e.type === "tool-denied");
    assert.ok(denied);

    const result = events.find((e) => e.type === "tool-result");
    assert.ok(result && result.type === "tool-result");
    assert.match(result.output, /permission denied/);
  });

  it("reports unknown tools as errors instead of throwing", async () => {
    const { service } = await makeService(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-3", name: "does_not_exist", arguments: "{}" }],
        },
        { role: "assistant", content: "sorry" },
      ],
      new AutoApproveGate(),
    );

    const events = await collect(service.send("do the impossible"));
    const result = events.find((e) => e.type === "tool-result");
    assert.ok(result && result.type === "tool-result");
    assert.match(result.output, /unknown tool/i);
  });
});
