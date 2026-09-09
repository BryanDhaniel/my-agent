import type { CredentialStore } from "./types.js";
import { CredentialStoreError } from "./types.js";

/**
 * In-memory store for tests and for callers that must not touch disk.
 * Same contract as the file-backed store, minus persistence.
 */
export class MemoryCredentialStore implements CredentialStore {
  readonly #values = new Map<string, string>();
  /** Set when a write should fail, so storage-failure paths are testable. */
  failWrites = false;

  async has(providerId: string): Promise<boolean> {
    return (this.#values.get(providerId) ?? "") !== "";
  }

  async get(providerId: string): Promise<string | undefined> {
    return this.#values.get(providerId);
  }

  async set(providerId: string, credential: string): Promise<void> {
    // Same contract as the file store: an empty value is never a credential.
    if (credential.trim() === "") {
      throw new CredentialStoreError("credential must not be empty");
    }
    if (this.failWrites) {
      throw new CredentialStoreError("credential storage is unavailable");
    }
    this.#values.set(providerId, credential);
  }

  async delete(providerId: string): Promise<void> {
    this.#values.delete(providerId);
  }

  async listConfigured(): Promise<string[]> {
    return [...this.#values.keys()].sort();
  }
}
