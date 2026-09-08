import path from "node:path";
import { realpath } from "node:fs/promises";
import type { CapabilitySet } from "./capabilities.js";
import type { FilesystemPolicy, SecurityDecision, SecurityMode } from "./types.js";

/**
 * Workspace boundary.
 *
 * Resolution order: normalize → resolve → check containment → resolve
 * symlinks → check containment again → check sensitive-file policy.
 *
 * Containment uses `path.relative`, never a naive string prefix: a prefix
 * check wrongly accepts `/project-secret` when the root is `/project`.
 */

export type PathOperation = "read" | "write" | "delete";

export interface PathDecision extends SecurityDecision {
  resolvedPath?: string;
}

/** Encoded traversal that a naive resolver would miss. */
const ENCODED_TRAVERSAL = /%2e|%2f|%5c|%252e/i;

/** Files that are never ordinary source, whatever the mode. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.env\..*$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)(credentials|service-?account|serviceAccountKey)[^/]*\.json$/i,
  /(^|\/)secrets?\.[^/]*$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.docker\/config\.json$/i,
];

export function isSensitivePath(target: string): boolean {
  const normalized = target.split(path.sep).join("/");
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * True when `target` is `root` or lives beneath it.
 * Case-insensitive on Windows, where the filesystem is case-insensitive.
 */
export function isPathInside(root: string, target: string): boolean {
  const a = path.resolve(root);
  const b = path.resolve(target);
  if (process.platform === "win32") {
    if (a.toLowerCase() === b.toLowerCase()) return true;
    const rel = path.relative(a, b);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }
  if (a === b) return true;
  const rel = path.relative(a, b);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Resolve symlinks/junctions one level up so escapes become visible. */
async function realpathOrParent(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    // Likely does not exist yet (a write target): resolve the parent instead.
    try {
      return path.join(await realpath(path.dirname(target)), path.basename(target));
    } catch {
      return undefined;
    }
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * The workspace root, with symlinks/junctions resolved.
 *
 * This matters more than it looks: if the root itself sits behind a link
 * (OneDrive folders, macOS `/tmp`, a junctioned checkout) then *every* path
 * under it has a realpath that differs from its resolved form. Without this
 * the boundary would deny the entire workspace as a series of escapes.
 */
const realRootCache = new Map<string, string>();

async function realWorkspaceRoot(root: string): Promise<string> {
  const cached = realRootCache.get(root);
  if (cached !== undefined) return cached;
  const value = (await realpathOrParent(root)) ?? root;
  realRootCache.set(root, value);
  return value;
}

export async function checkPathAccess(input: {
  workspaceRoot: string;
  requested: string;
  cwd: string;
  operation: PathOperation;
  policy: FilesystemPolicy;
  capabilities: CapabilitySet;
  mode?: SecurityMode;
}): Promise<PathDecision> {
  const { workspaceRoot, requested, cwd, operation, policy, capabilities } = input;

  const deny = (reason: string, riskLevel: PathDecision["riskLevel"] = "high"): PathDecision => ({
    allowed: false,
    requiresConfirmation: false,
    reason,
    riskLevel,
  });

  if (requested === undefined || requested.trim() === "") {
    return deny("empty path");
  }
  if (requested.includes("\0")) {
    return deny("path contains a null byte", "critical");
  }
  if (ENCODED_TRAVERSAL.test(requested)) {
    return deny("path contains encoded traversal sequences", "critical");
  }

  // UNC paths (\\server\share) are outside any local workspace.
  if (process.platform === "win32" && /^\\\\/.test(requested)) {
    return deny("UNC paths are not permitted", "critical");
  }

  const resolved = path.resolve(cwd, requested);

  // A different drive can never be inside the workspace root.
  if (process.platform === "win32") {
    const rootDrive = path.parse(path.resolve(workspaceRoot)).root.toLowerCase();
    const targetDrive = path.parse(resolved).root.toLowerCase();
    if (rootDrive !== targetDrive) {
      return deny(`path is on drive ${targetDrive}, outside the workspace`, "critical");
    }
  }

  for (const deniedRoot of policy.deniedPaths) {
    if (isPathInside(deniedRoot, resolved)) {
      return deny(`path is inside denied location "${deniedRoot}"`, "critical");
    }
  }

  const extraAllowed =
    operation === "read"
      ? policy.allowedReadPaths
      : [...policy.allowedWritePaths, ...policy.allowedReadPaths];

  const realRoot = await realWorkspaceRoot(workspaceRoot);
  const insideWorkspace =
    isPathInside(workspaceRoot, resolved) || isPathInside(realRoot, resolved);
  const insideExtra = extraAllowed.some((root) => isPathInside(root, resolved));

  if (!insideWorkspace && !insideExtra) {
    return deny("path resolves outside the configured workspace", "critical");
  }

  // Symlink / junction escape: resolve and re-check. A link that stays inside
  // the workspace is harmless; one that leaves it is refused.
  const real = await realpathOrParent(resolved);
  if (real !== undefined && !samePath(real, resolved)) {
    const realInsideWorkspace =
      isPathInside(workspaceRoot, real) || isPathInside(realRoot, real);
    if (!realInsideWorkspace) {
      const realInsideExtra = extraAllowed.some((root) => isPathInside(root, real));
      if (!realInsideExtra) {
        return deny("symlink or junction resolves outside the workspace", "critical");
      }
      // Leaving the workspace for an explicitly allowed location is opt-in.
      if (!policy.allowSymlinks) {
        return deny("symlink or junction leaving the workspace is not permitted", "high");
      }
    }
  }

  if (isSensitivePath(resolved)) {
    if (operation === "read") {
      return deny(
        "sensitive file: reading credentials and secret files is denied by default",
        "high",
      );
    }
    return deny("sensitive file: refusing to write or modify secret material", "critical");
  }

  // .git is readable (git commands need it) but not writable through tools.
  if (operation !== "read" && isGitInternal(resolved)) {
    return deny("refusing to modify .git internals directly — use git commands", "high");
  }

  if (operation === "delete" && !policy.allowDelete) {
    return deny("delete is disabled by the filesystem policy", "high");
  }

  const requiredCapability =
    operation === "read" ? "filesystem.read" : operation === "delete" ? "filesystem.delete" : "filesystem.write";

  if (!capabilities.has(requiredCapability)) {
    return {
      allowed: false,
      requiresConfirmation: false,
      reason: `blocked: missing capability "${requiredCapability}"`,
      riskLevel: "high",
      capability: requiredCapability,
    };
  }

  return {
    allowed: true,
    requiresConfirmation: false,
    reason: `allowed: ${operation} inside workspace`,
    riskLevel: operation === "read" ? "low" : "medium",
    capability: requiredCapability,
    resolvedPath: resolved,
  };
}

function isGitInternal(target: string): boolean {
  const normalized = target.split(path.sep).join("/");
  return /(^|\/)\.git(\/|$)/i.test(normalized);
}
