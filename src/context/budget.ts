/**
 * Token budget for a single LLM request.
 *
 * The model's context window is split before any message is chosen:
 *
 *   maxTokens ─ reservedOutputTokens = input
 *                                      ├─ system (instructions, task, permissions)
 *                                      ├─ skills
 *                                      ├─ memory
 *                                      └─ conversation (gets every unused token)
 *
 * Section shares are ceilings, not reservations: a section that does not use
 * its share leaves the slack to the sections below it, so a short system
 * prompt never starves the conversation.
 */

export interface ContextBudgetSpec {
  /** Tokens in the model's context window. */
  maxTokens?: number;
  /** Tokens held back for the model's reply — never spent on input. */
  reservedOutputTokens?: number;
  /** Share of the input budget for instructions (system + task + permissions). */
  systemShare?: number;
  /** Share of the input budget for active Skill instructions. */
  skillShare?: number;
  /** Share of the input budget for retrieved memories. */
  memoryShare?: number;
}

export interface ContextBudget {
  /** The model's context window. */
  maxTokens: number;
  /** Held back for the reply. */
  reservedOutputTokens: number;
  /** Tokens actually available for input: maxTokens − reservedOutputTokens. */
  input: number;
  /** Ceiling for instructions (system + task + permissions). */
  system: number;
  /** Ceiling for active Skill instructions. */
  skills: number;
  /** Ceiling for retrieved memories. */
  memory: number;
  /** Ceiling for the conversation, plus any slack from the sections above. */
  conversation: number;
}

export const DEFAULT_MAX_TOKENS = 96_000;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_000;
export const DEFAULT_SYSTEM_SHARE = 0.15;
export const DEFAULT_SKILL_SHARE = 0.1;
export const DEFAULT_MEMORY_SHARE = 0.1;

/** Floor so a tiny window still leaves room for one Turn Group. */
const MIN_CONVERSATION_TOKENS = 1;

export function resolveBudget(spec: ContextBudgetSpec = {}): ContextBudget {
  const maxTokens = positiveInt(spec.maxTokens, DEFAULT_MAX_TOKENS);
  const reservedOutputTokens = Math.min(
    nonNegativeInt(spec.reservedOutputTokens, DEFAULT_RESERVED_OUTPUT_TOKENS),
    maxTokens,
  );
  const input = Math.max(0, maxTokens - reservedOutputTokens);

  const systemShare = share(spec.systemShare, DEFAULT_SYSTEM_SHARE);
  const skillShare = share(spec.skillShare, DEFAULT_SKILL_SHARE);
  const memoryShare = share(spec.memoryShare, DEFAULT_MEMORY_SHARE);

  // Never let the fixed sections claim more than the input window itself.
  const scale = systemShare + skillShare + memoryShare;
  const system = Math.floor(input * (scale > 1 ? systemShare / scale : systemShare));
  const skills = Math.floor(input * (scale > 1 ? skillShare / scale : skillShare));
  const memory = Math.floor(input * (scale > 1 ? memoryShare / scale : memoryShare));

  const conversation = Math.max(
    MIN_CONVERSATION_TOKENS,
    input - system - skills - memory,
  );

  return { maxTokens, reservedOutputTokens, input, system, skills, memory, conversation };
}

/**
 * Per-kind ceilings for selection.
 *
 * The four instruction kinds split the system share between them so they
 * cannot collectively crowd out the conversation. Conversation is capped at
 * the whole input window on purpose: it is selected last, so it receives
 * exactly whatever the higher-priority sections did not spend.
 */
export const INSTRUCTION_SHARES = {
  system: 0.5,
  summary: 0.2,
  task: 0.15,
  permissions: 0.15,
} as const;

export function budgetCaps(budget: ContextBudget): Record<string, number> {
  return {
    system: Math.floor(budget.system * INSTRUCTION_SHARES.system),
    summary: Math.floor(budget.system * INSTRUCTION_SHARES.summary),
    task: Math.floor(budget.system * INSTRUCTION_SHARES.task),
    permissions: Math.floor(budget.system * INSTRUCTION_SHARES.permissions),
    skill: budget.skills,
    memory: budget.memory,
    conversation: budget.input,
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function share(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}
