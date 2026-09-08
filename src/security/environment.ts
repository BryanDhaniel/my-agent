import { redactSecrets } from "../memory/sanitize.js";
import type { CapabilitySet } from "./capabilities.js";
import type { EnvironmentPolicy, SecurityDecision } from "./types.js";

/**
 * Environment access.
 *
 * `process.env` is never handed to the model wholesale: secret-shaped
 * variables are withheld, and values are passed through the existing
 * `redactSecrets` so a leak cannot hide in a value.
 */

export const SECRET_ENV_PATTERNS: RegExp[] = [
  /_API_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_PASSWD$/i,
  /_PRIVATE_KEY$/i,
  /_CREDENTIALS?$/i,
  /_CONNECTION_STRING$/i,
  /^AWS_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^GEMINI_/i,
  /^GLM_/i,
  /^GITHUB_TOKEN$/i,
  /^NPM_TOKEN$/i,
  /^DATABASE_URL$/i,
];

export function isSecretEnvVar(name: string): boolean {
  return SECRET_ENV_PATTERNS.some((pattern) => pattern.test(name));
}

export function checkEnvironmentAccess(input: {
  name: string;
  policy: EnvironmentPolicy;
  capabilities: CapabilitySet;
}): SecurityDecision {
  const { name, policy, capabilities } = input;

  if (policy.deniedVariables.includes(name)) {
    return {
      allowed: false,
      requiresConfirmation: false,
      reason: `environment variable "${name}" is denied by policy`,
      riskLevel: "high",
      capability: "environment.read",
    };
  }

  if (isSecretEnvVar(name)) {
    return {
      allowed: false,
      requiresConfirmation: false,
      reason: `environment variable "${name}" is secret-shaped and cannot be read by the agent`,
      riskLevel: "critical",
      capability: "environment.read",
    };
  }

  if (policy.allowedVariables.includes(name)) {
    return {
      allowed: true,
      requiresConfirmation: false,
      reason: "explicitly allowed variable",
      riskLevel: "low",
      capability: "environment.read",
    };
  }

  if (!policy.allowSafeVariables || !capabilities.has("environment.read_safe")) {
    return {
      allowed: false,
      requiresConfirmation: false,
      reason: 'blocked: missing capability "environment.read_safe"',
      riskLevel: "medium",
      capability: "environment.read_safe",
    };
  }

  return {
    allowed: true,
    requiresConfirmation: false,
    reason: "non-secret variable",
    riskLevel: "low",
    capability: "environment.read_safe",
  };
}

/**
 * A filtered, redacted view of the environment. Callers get this instead of
 * `process.env`.
 */
export function safeEnvironment(input: {
  policy: EnvironmentPolicy;
  capabilities: CapabilitySet;
  source?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = input.source ?? process.env;
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const decision = checkEnvironmentAccess({
      name,
      policy: input.policy,
      capabilities: input.capabilities,
    });
    if (!decision.allowed) continue;
    out[name] = redactSecrets(value);
  }

  return out;
}
