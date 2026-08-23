# my-agent

A terminal coding agent built from scratch: an LLM that can read, edit, and search a codebase and run commands, driven by a hand-rolled agent loop.

## Language

**Agent Loop**:
The cycle of sending the conversation to the model, executing any tool calls it requests, feeding results back, and repeating until the model produces a final answer.
_Avoid_: main loop, run loop, inference loop

**Turn**:
One complete pass through the Agent Loop — one model response plus the execution of its tool calls.
_Avoid_: step, iteration

**Tool**:
A named capability the model can invoke by emitting a tool call, with a typed input schema. The model never runs code; it only requests Tool Calls.
_Avoid_: function, command, action

**Tool Call**:
A request from the model to invoke a Tool, carrying arguments. Not yet executed or approved.
_Avoid_: tool use, function call

**Tool Result**:
The output of an executed Tool Call, fed back into the conversation as input for the next Turn.

**Permission Gate**:
The check that runs before any mutating Tool Call executes (writes, edits, bash): ask the user, honor a session allowlist, or pass through in YOLO mode.
_Avoid_: confirmation, approval flow

**Session**:
A persisted conversation: the full message history plus metadata, stored as append-only JSONL on disk so it can be resumed later.
_Avoid_: chat, conversation, thread

**Provider**:
An LLM vendor integration behind our uniform `Provider` interface (Anthropic, OpenAI). Owns translating messages/tools/events to that vendor's API shape.
_Avoid_: backend, client, driver
