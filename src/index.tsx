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
import { SecurityManager, defaultSecurityPolicy, resolveSecurityMode } from "./security/index.js";
import type {
  ExecutionContext,
  ExecutionKind,
  ObservabilityEventType,
} from "./observability/events.js";
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

  // One context per execution, not per event: a task or sub-agent keeps the
  // same executionId for its whole lifetime so the tree can be rebuilt.
  const childContexts = new Map<string, ExecutionContext>();
  const contextFor = (key: string, kind: ExecutionKind): ExecutionContext => {
    const existing = childContexts.get(key);
    if (existing !== undefined) return existing;
    const created = observability.child(runContext, kind);
    childContexts.set(key, created);
    return created;
  };

  const bridgeSubAgent = (event: SubAgentEvent): void => {
    const type: ObservabilityEventType =
      event.type === "subagent.tool_call" ? "tool.started" : (event.type as ObservabilityEventType);
    const role = "role" in event ? event.role : "sub-agent";
    observability.emit({
      type,
      context: contextFor(`subagent:${role}`, "sub-agent"),
      metadata: { agent: role },
    });
  };

  const bridgeOrchestration = (event: OrchestrationEvent): void => {
    const isTask = event.type.startsWith("task.");
    const id = "taskId" in event ? event.taskId : undefined;
    const key = isTask && id !== undefined ? `task:${id}` : "orchestration";
    observability.emit({
      type: event.type as ObservabilityEventType,
      context: contextFor(key, isTask ? "task" : "main-agent"),
      ...(id !== undefined ? { metadata: { taskId: id } } : {}),
    });
  };

  // The security boundary is created once here and handed down. Every tool
  // call — main agent, sub-agent and MCP — is authorized against it; children
  // get a narrowed context rather than this one.
  const securityMode = resolveSecurityMode(flags.securityMode);
  const security = new SecurityManager({
    policy: defaultSecurityPolicy(cwd, securityMode),
    observability,
    executionId: `${runContext.executionId}:main`,
    parentExecutionId: runContext.executionId,
    runId: runContext.runId,
    label: "main",
  });

  // Sub-agents reuse the parent's tools, permission gate and provider/model
  // defaults; each child gets its own context and a filtered tool registry.
  const subagents = new SubAgentManager({
    parent: { provider: config.provider, model: config.model },
    registry,
    gate: permGate,
    cwd,
    skills: skillRegistry,
    security,
    onEvent: bridgeSubAgent,
    observability,
    // Share one context between a child's security boundary and its trace.
    executionContextFactory: (_spec, role) =>
      contextFor(`subagent:${role}`, "sub-agent"),
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
    security,
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
