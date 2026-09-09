import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProviderName, type ProviderName } from "../config.js";
import { CREDENTIALS_DIR } from "../credentials/file-store.js";
import { resolveModelId } from "./registry.js";

/**
 * The runtime selection: which provider and model new runs start with.
 *
 * Deliberately a different file from the credentials — this one is safe to
 * read aloud, print in the UI and copy into a session. It holds ids only.
 */

export const CONFIG_FILE = path.join(CREDENTIALS_DIR, "config.json");

export interface ActiveSelection {
  providerId: ProviderName;
  modelId: string;
}

interface ConfigFile {
  version: 1;
  provider?: string;
  model?: string;
}

/** Small file store for the active selection. Corrupt or missing is normal. */
export class ActiveConfigStore {
  readonly #file: string;

  constructor(file: string = CONFIG_FILE) {
    this.#file = file;
  }

  async load(): Promise<ActiveSelection | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch {
      return undefined; // first run
    }

    let data: ConfigFile;
    try {
      data = JSON.parse(raw) as ConfigFile;
    } catch {
      return undefined; // hand-edited or truncated: fall back to defaults
    }

    if (typeof data.provider !== "string" || !isProviderName(data.provider)) {
      return undefined;
    }
    const providerId = data.provider;
    const modelId = resolveModelId(providerId, data.model);
    if (modelId === undefined) return undefined;

    return { providerId, modelId };
  }

  async save(selection: ActiveSelection): Promise<void> {
    const payload: ConfigFile = {
      version: 1,
      provider: selection.providerId,
      model: selection.modelId,
    };
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temp, this.#file);
  }
}
