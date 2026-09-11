export interface SlashCommand {
  /** Command name without the leading slash. */
  name: string;
  description: string;
}

/** Built-in slash commands, in display order. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "show commands and tips" },
  { name: "new", description: "start a fresh session" },
  { name: "session", description: "list, switch to, or delete sessions" },
  { name: "provider", description: "select or configure a provider" },
  { name: "model", description: "select a model for the active provider" },
  { name: "effort", description: "set reasoning effort (low, medium, high, xhigh, max)" },
  { name: "skills", description: "list available skills" },
  { name: "exit", description: "quit my-agent" },
];

/**
 * Suggestions for the current input — active while the user is still
 * typing a bare command like "/se" (slash + letters, no space).
 *
 * Merges built-in commands with optional extra commands (e.g. from skills).
 */
export function suggestCommands(
  value: string,
  extra: readonly SlashCommand[] = [],
): SlashCommand[] {
  if (!/^\/[a-zA-Z-]*$/.test(value)) return [];
  const typed = value.slice(1).toLowerCase();
  const all = [...SLASH_COMMANDS, ...extra];
  return all.filter((c) => c.name.toLowerCase().startsWith(typed));
}
