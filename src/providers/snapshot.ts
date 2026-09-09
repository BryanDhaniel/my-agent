/**
 * The provider and model a run was started with.
 *
 * A run captures this once and never re-reads it, so switching provider or
 * model mid-flight cannot retarget work that is already underway — the main
 * agent, a sub-agent, a parallel task, or a retry.
 */
export interface ModelSnapshot {
  providerId: string;
  modelId: string;
}

export function snapshotOf(provider: { name: string; model: string }): ModelSnapshot {
  return { providerId: provider.name, modelId: provider.model };
}

/** Fill in only what the child did not explicitly choose. */
export function inheritSnapshot(
  snapshot: ModelSnapshot | undefined,
  override?: { provider?: string; model?: string },
): { provider?: string; model?: string } {
  const provider = override?.provider ?? snapshot?.providerId;
  const model = override?.model ?? snapshot?.modelId;
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}
