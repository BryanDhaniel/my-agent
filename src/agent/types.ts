export interface ToolCallRequest {
  id: string;
  name: string;
  /** JSON-encoded arguments, exactly as requested by the model */
  arguments: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCallRequest[];
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; toolCallId: string; content: string };

export function isAssistant(m: ChatMessage): m is AssistantMessage {
  return m.role === "assistant";
}
