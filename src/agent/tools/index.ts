import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { runBashTool } from "./run-bash.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { ToolRegistry } from "../registry.js";

export function defaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(runBashTool);
  registry.register(globTool);
  registry.register(grepTool);
  return registry;
}
