#!/usr/bin/env node
import { render, Text } from "ink";
import React from "react";
import { ChatService } from "./agent/chat.js";
import { defaultRegistry } from "./agent/tools/index.js";
import { USAGE, parseArgs } from "./cli-args.js";
import { ConfigError, loadConfig } from "./config.js";
import { AskUserGate, AutoApproveGate, NOOP_UI_GATE } from "./permissions/gate.js";
import type { PermissionGate, UiGate } from "./permissions/gate.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { SessionStore } from "./session/store.js";
import { App } from "./ui/app.js";

async function boot(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig(flags);
  const provider =
    config.provider === "openai"
      ? new OpenAIProvider(config.apiKey, config.model)
      : new AnthropicProvider(config.apiKey, config.model);
  const registry = defaultRegistry();

  let uiGate: UiGate = NOOP_UI_GATE;
  let permGate: PermissionGate = new AutoApproveGate();
  if (!flags.yolo) {
    const askGate = new AskUserGate();
    uiGate = askGate;
    permGate = askGate;
  }

  const service = await ChatService.start(provider, new SessionStore(), registry, permGate, flags);

  render(<App service={service} gate={uiGate} />);
}

boot().catch((err) => {
  const message =
    err instanceof Error ? err.message : err instanceof Object ? String(err) : "Unknown error";
  render(<Text color="red">✗ {message}</Text>);
  process.exit(1);
});
