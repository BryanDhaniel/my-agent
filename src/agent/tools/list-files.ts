import { readdir } from "node:fs/promises";
import path from "node:path";

const ALWAYS_SKIP = new Set(["node_modules", ".git"]);

const MAX_FILES = 5_000;

/**
 * Recursively list files under root as forward-slash relative paths,
 * skipping node_modules/.git and dotfiles at the top level.
 */
export async function listFiles(
  root: string,
  limit: number = MAX_FILES,
): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentRelative = path.relative(root, entry.parentPath);
    const topSegment = parentRelative.split(path.sep)[0];
    if (
      (topSegment && topSegment.startsWith(".")) ||
      (parentRelative && parentRelative.split(path.sep).some((s) => ALWAYS_SKIP.has(s)))
    ) {
      continue;
    }
    files.push(parentRelative ? `${parentRelative.split(path.sep).join("/")}/${entry.name}` : entry.name);
    if (files.length >= limit) break;
  }

  return files.sort();
}
