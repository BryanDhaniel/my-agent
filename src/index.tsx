#!/usr/bin/env node
import { render, Text } from "ink";
import React from "react";
import { AgentHarness } from "./harness/harness.js";
import { defaultRegistry } from "./agent/tools/index.js";
import { USAGE, parseArgs } from "./cli-args.js";
import { ConfigError, loadConfig } from "./config.js";
import { AskUserGate, AutoApproveGate, NOOP_UI_GATE } from "./permissions/gate.js";
import type { PermissionGate, UiGate } from "./permissions/gate.js";
import { createProvider } from "./providers/create-provider.js";
import { SessionStore } from "./session/store.js";
import { loadMcpConfig } from "./mcp/index.js";
import { loadAllSkills, SkillRegistry } from "./skills/index.js";
import { SubAgentManager } from "./subagent/manager.js";
import { delegateToAgentTool } from "./agent/tools/delegate-to-agent.js";
import { orchestrateTasksTool } from "./agent/tools/orchestrate-tasks.js";
import { TaskOrchestrator } from "./orchestration/orchestrator.js";
import { Observability } from "./observability/index.js";
import type { ObservabilityEventType } from "./observability/events.js";
import type { SubAgentEvent } from "./subagent/types.js";
import type { OrchestrationEvent } from "./orchestration/types.js";
import { join } from "node:path";
import { App } from "./ui/app.js";

async function boot(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig(flags);
  const provider = createProvider(config);
  const registry = defaultRegistry();
  const store = new SessionStore();

  let uiGate: UiGate = NOOP_UI_GATE;
  let permGate: PermissionGate = new AutoApproveGate();
  if (!flags.yolo) {
    const askGate = new AskUserGate();
    uiGate = askGate;
    permGate = askGate;
  }

  const mcpConfig = await loadMcpConfig(process.cwd());

  // Discover skills from .agents/skills/ and skills/ directories.
  const skillRegistry = new SkillRegistry();
  const cwd = process.cwd();
  const skillSources = [
    join(cwd, ".agents", "skills"),
    join(cwd, "skills"),
  ];
  for (const dir of skillSources) {
    const loaded = await loadAllSkills(dir);
    skillRegistry.registerAll(loaded);
  }
  if (skillRegistry.size > 0) {
    console.error(`skills: ${skillRegistry.size} loaded`);
  }

  // One observability sink for events, logs, metrics and traces. Sub-agent
  // and orchestration lifecycles are bridged into it so the whole execution
  // tree is reconstructable, not just the main agent's.
  const observability = new Observability({ level: flags.debug ? "debug" : "info" });
  const runContext = observability.newRun();

  const bridgeSubAgent = (event: SubAgentEvent): void => {
    const type: ObservabilityEventType =
      event.type === "subagent.tool_call" ? "tool.started" : (event.type as ObservabilityEventType);
    observability.emit({ type, context: observability.child(runContext, "sub-agent") });
  };

  const bridgeOrchestration = (event: OrchestrationEvent): void => {
    const context = observability.child(
      runContext,
      event.type.startsWith("task.") ? "task" : "main-agent",
    );
    observability.emit({ type: event.type as ObservabilityEventType, context });
  };

  // Sub-agents reuse the parent's tools, permission gate and provider/model
  // defaults; each child gets its own context and a filtered tool registry.
  const subagents = new SubAgentManager({
    parent: { provider: config.provider, model: config.model },
    registry,
    gate: permGate,
    cwd,
    skills: skillRegistry,
    onEvent: bridgeSubAgent,
  });
  registry.register(delegateToAgentTool(subagents));

  // Parallel orchestration sits above the manager: each planned task is
  // executed through the same SubAgentManager lifecycle.
  registry.register(
    orchestrateTasksTool(new TaskOrchestrator({ manager: subagents, onEvent: bridgeOrchestration })),
  );

  const harness = await AgentHarness.create(provider, {
    store,
    registry,
    gate: permGate,
    mcpConfig,
    skills: skillRegistry,
    ...flags,
  });

  harness.setObservability(observability);

  // Log MCP server statuses.
  for (const status of harness.mcpStatuses) {
    if (status.status === "connected") {
      console.error(`mcp: ${status.name} connected (${status.toolCount} tools)`);
    } else {
      console.error(`mcp: ${status.name} failed — ${status.error}`);
    }
  }

  // Clean up MCP clients on exit.
  const cleanup = () => {
    void harness.close();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  render(<App service={harness as any} gate={uiGate} store={store} />);
}

boot().catch((err) => {
  const message =
    err instanceof Error ? err.message : err instanceof Object ? String(err) : "Unknown error";
  render(<Text color="red">✗ {message}</Text>);
  process.exit(1);
});
