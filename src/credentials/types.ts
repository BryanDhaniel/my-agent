/**
 * Credentials are their own thing.
 *
 * They are deliberately not part of the session, memory, context or any
 * configuration object that gets serialized into a transcript. The value
 * lives here and is handed to exactly one caller: the code that builds a
 * Provider.
 */

/** How a provider expects to be authenticated. OAuth is not implemented. */
export interface CredentialDefinition {
  type: "api-key";
  /** Legacy environment variable used as a bootstrap source. */
  environmentVariable?: string;
  label: string;
  /** Hint shown next to the masked input. Never a real key. */
  hint?: string;
}

export interface CredentialStore {
  has(providerId: string): Promise<boolean>;
  get(providerId: string): Promise<string | undefined>;
  set(providerId: string, credential: string): Promise<void>;
  delete(providerId: string): Promise<void>;
  listConfigured(): Promise<string[]>;
}

export class CredentialStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialStoreError";
  }
}

/** The credential exists locally but the provider rejected it. */
export class CredentialValidationError extends Error {
  readonly providerId: string;

  constructor(providerId: string, reason: string) {
    super(reason);
    this.name = "CredentialValidationError";
    this.providerId = providerId;
  }
}

export class ProviderNotFoundError extends Error {
  constructor(providerId: string) {
    super(`Unknown provider "${providerId}"`);
    this.name = "ProviderNotFoundError";
  }
}

export class ProviderNotConfiguredError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`Provider "${providerId}" is not configured`);
    this.name = "ProviderNotConfiguredError";
    this.providerId = providerId;
  }
}
