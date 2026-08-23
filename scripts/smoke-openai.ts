/**
 * End-to-end check for the OpenAI provider: streams one prompt to stdout.
 * Run: npm run smoke:openai   (requires OPENAI_API_KEY)
 */
import { loadConfig } from "../src/config.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import type { StreamEvent } from "../src/providers/provider.js";

async function main(): Promise<void> {
  const config = loadConfig({ provider: "openai" });
  const provider = new OpenAIProvider(config.apiKey, config.model);

  console.log(`provider=${provider.name} model=${provider.model}`);
  console.log("---");

  const stream = provider.stream([
    { role: "system", content: "You are my-agent, a terminal coding agent." },
    { role: "user", content: "Say hello in exactly five words." },
  ]);

  let chars = 0;
  for await (const event of stream as AsyncGenerator<StreamEvent>) {
    if (event.type === "text-delta") {
      process.stdout.write(event.delta);
      chars += event.delta.length;
    } else if (event.type === "done") {
      process.stdout.write("\n---\n");
      console.log(`done: ${chars} chars streamed`);
    } else {
      console.error(`\n✗ error:`, event.error);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
