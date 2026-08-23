import { z } from "zod";

/** Single place where tool schemas become JSON Schema for the wire format. */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}
