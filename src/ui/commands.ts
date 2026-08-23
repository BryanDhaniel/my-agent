export interface SlashCommand {
  /** Command name without the leading slash. */
  name: string;
  description: string;
}

/** All slash commands, in display order. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "show commands and tips" },
  { name: "new", description: "start a fresh session" },
  { name: "session", description: "list, switch to, or delete sessions" },
  { name: "exit", description: "quit my-agent" },
];

/**
 * Suggestions for the current input — active while the user is still
 * typing a bare command like "/se" (slash + letters, no space).
 */
export function suggestCommands(value: string): SlashCommand[] {
  if (!/^\/[a-zA-Z]*$/.test(value)) return [];
  const typed = value.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(typed));
}
