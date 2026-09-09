import type { CredentialStore } from "./types.js";

export * from "./types.js";
export * from "./file-store.js";
export * from "./memory-store.js";

/**
 * Resolve a credential without ever surfacing it.
 *
 * Order matters: the local store wins, and the environment is only a legacy
 * bootstrap source. Neither value is logged, and the returned marker says
 * where it came from so the UI can tell the user without printing anything.
 */
export type CredentialSource = "store" | "environment" | "none";

export interface ResolvedCredential {
  value: string | undefined;
  source: CredentialSource;
}

export async function resolveCredential(input: {
  store: CredentialStore;
  providerId: string;
  environmentVariable?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedCredential> {
  const stored = await input.store.get(input.providerId);
  if (stored !== undefined && stored !== "") {
    return { value: stored, source: "store" };
  }

  const name = input.environmentVariable;
  if (name !== undefined && name !== "") {
    const fromEnv = (input.env ?? process.env)[name];
    if (typeof fromEnv === "string" && fromEnv !== "") {
      return { value: fromEnv, source: "environment" };
    }
  }

  return { value: undefined, source: "none" };
}
