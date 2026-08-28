/**
 * End-to-end Agent Loop check: real provider, real tools, auto-approved writes.
 * Run: npm run smoke:agent   (requires OPENAI_API_KEY via env or .env.local)
 */
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentHarness } from "../src/harness/harness.js";
import { defaultRegistry } from "../src/agent/tools/index.js";
import { loadConfig } from "../src/config.js";
import { AutoApproveGate } from "../src/permissions/gate.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { SessionStore } from "../src/session/store.js";

async function main(): Promise<void> {
  const config = loadConfig({ provider: "openai" });
  const workdir = await mkdtemp(path.join(os.tmpdir(), "my-agent-e2e-"));
  console.log(`workdir: ${workdir}`);

  const provider = new OpenAIProvider(config.apiKey, config.model);
  const harness = await AgentHarness.create(provider, {
    store: new SessionStore(path.join(workdir, "sessions")),
    registry: defaultRegistry(),
    gate: new AutoApproveGate(),
    cwd: workdir,
  });

  const prompt = [
    "Use your tools:",
    "1. Create notes.txt containing exactly 'hello world'",
    "2. Use edit_file to replace 'world' with 'there'",
    "3. Run a bash command to print the file",
    "4. Grep for 'there' and report the match",
  ].join(" ");
  console.log(`you: ${prompt}\n`);

  for await (const event of harness.run(prompt)) {
    switch (event.type) {
      case "text-delta":
        process.stdout.write(event.delta);
        break;
      case "assistant-message":
        process.stdout.write("\n");
        break;
      case "tool-start":
        console.log(`  ⚙ ${event.toolName} ${event.argsJson}`);
        break;
      case "tool-denied":
        console.log(`  ✗ denied: ${event.reason}`);
        break;
      case "tool-result":
        console.log(`  ✓ ${event.output.split("\n")[0]}`);
        break;
      case "user-message":
        break;
      case "error":
        console.error(`\n✗ error:`, event.error);
        process.exit(1);
    }
  }

  const written = await readFile(path.join(workdir, "notes.txt"), "utf8");
  console.log(`\n---\nnotes.txt on disk: ${JSON.stringify(written)}`);
  if (written !== "hello there") {
    console.error("✗ expected notes.txt to contain 'hello there'");
    process.exit(1);
  }
  console.log("✓ end-to-end ok");
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
