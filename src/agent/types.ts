export interface ToolCallRequest {
  id: string;
  name: string;
  /** JSON-encoded arguments, exactly as requested by the model */
  arguments: string;
  /**
   * Opaque, provider-issued signature for this call. Some providers require it
   * to be echoed back verbatim alongside the function call on the next request
   * or they reject the turn (Gemini 3 returns 400 INVALID_ARGUMENT when a
   * functionCall part is missing its `thoughtSignature`). Providers that do not
   * use it simply leave it undefined.
   */
  thoughtSignature?: string;
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
