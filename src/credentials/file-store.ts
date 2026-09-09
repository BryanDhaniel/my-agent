import { mkdir, readFile, rename, writeFile, chmod, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CredentialStoreError, type CredentialStore } from "./types.js";

/**
 * Local credential storage.
 *
 * This is the only place an API key is persisted. It is not a session file,
 * not memory, and not context — nothing that gets replayed to a model or
 * written into a transcript ever holds the value.
 *
 * Security posture: owner-only directory and file where the platform supports
 * it, atomic replace on write, and a corrupt file fails closed rather than
 * being guessed at. On platforms without POSIX permissions (Windows) the
 * file is created normally and the limitation is documented instead of
 * pretended away.
 */

export const CREDENTIALS_DIR = path.join(os.homedir(), ".my-agent");
export const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json");

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

interface CredentialFile {
  version: 1;
  credentials: Record<string, string>;
}

function emptyFile(): CredentialFile {
  return { version: 1, credentials: {} };
}

function parse(raw: string): CredentialFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // A truncated or hand-edited file must not be silently discarded: the
    // user may have real keys in it.
    throw new CredentialStoreError(
      `credentials file is not valid JSON — refusing to overwrite it (${CREDENTIALS_FILE})`,
    );
  }

  if (typeof data !== "object" || data === null) {
    throw new CredentialStoreError("credentials file has an unexpected shape");
  }

  const record = data as { credentials?: unknown };
  if (record.credentials === undefined) return emptyFile();

  if (typeof record.credentials !== "object" || record.credentials === null) {
    throw new CredentialStoreError("credentials file has an unexpected shape");
  }

  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.credentials)) {
    if (typeof value === "string" && value !== "") credentials[key] = value;
  }
  return { version: 1, credentials };
}

export class FileCredentialStore implements CredentialStore {
  readonly #file: string;

  constructor(file: string = CREDENTIALS_FILE) {
    this.#file = file;
  }

  get file(): string {
    return this.#file;
  }

  async #read(): Promise<CredentialFile> {
    try {
      return parse(await readFile(this.#file, "utf8"));
    } catch (err) {
      if (isMissing(err)) return emptyFile();
      if (err instanceof CredentialStoreError) throw err;
      throw new CredentialStoreError(`cannot read credentials: ${message(err)}`, {
        cause: err,
      });
    }
  }

  async #write(data: CredentialFile): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: DIR_MODE });
    const temp = `${this.#file}.${process.pid}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, {
        mode: FILE_MODE,
        encoding: "utf8",
      });
      await rename(temp, this.#file);
      await this.#restrict();
    } catch (err) {
      throw new CredentialStoreError(`cannot write credentials: ${message(err)}`, {
        cause: err,
      });
    }
  }

  /** Best effort: POSIX-only in practice, and failure is not fatal. */
  async #restrict(): Promise<void> {
    try {
      await chmod(this.#file, FILE_MODE);
    } catch {
      // Windows and some network filesystems reject chmod. The file is still
      // written; the README documents the limitation.
    }
  }

  async has(providerId: string): Promise<boolean> {
    const value = (await this.#read()).credentials[providerId];
    return typeof value === "string" && value !== "";
  }

  async get(providerId: string): Promise<string | undefined> {
    return (await this.#read()).credentials[providerId];
  }

  async set(providerId: string, credential: string): Promise<void> {
    if (credential.trim() === "") {
      throw new CredentialStoreError("credential must not be empty");
    }
    const data = await this.#read();
    data.credentials[providerId] = credential;
    await this.#write(data);
  }

  async delete(providerId: string): Promise<void> {
    const data = await this.#read();
    if (data.credentials[providerId] === undefined) return;
    delete data.credentials[providerId];
    await this.#write(data);
  }

  async listConfigured(): Promise<string[]> {
    return Object.keys((await this.#read()).credentials).sort();
  }

  /** Diagnostics only — never the values themselves. */
  async permissions(): Promise<number | undefined> {
    try {
      const info = await stat(this.#file);
      return info.mode & 0o777;
    } catch {
      return undefined;
    }
  }
}

function isMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "ENOENT";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
