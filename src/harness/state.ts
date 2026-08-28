export type RunStatus =
  | "idle"
  | "running"
  | "awaiting-permission"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunState {
  readonly status: RunStatus;
  readonly turns: number;
  readonly error?: string;
}

export const INITIAL_RUN_STATE: RunState = {
  status: "idle",
  turns: 0,
};

export function startRun(state: RunState): RunState {
  return {
    ...state,
    status: "running",
    error: undefined,
  };
}

export function setAwaitingPermission(state: RunState, awaiting: boolean): RunState {
  if (awaiting && state.status === "running") {
    return { ...state, status: "awaiting-permission" };
  }
  if (!awaiting && state.status === "awaiting-permission") {
    return { ...state, status: "running" };
  }
  return state;
}

export function incrementTurn(state: RunState): RunState {
  return {
    ...state,
    turns: state.turns + 1,
  };
}

export function completeRun(state: RunState, turnsCompleted?: number): RunState {
  return {
    ...state,
    status: "completed",
    turns: turnsCompleted ?? state.turns,
  };
}

export function failRun(state: RunState, error: string): RunState {
  return {
    ...state,
    status: "failed",
    error,
  };
}

export function cancelRun(state: RunState): RunState {
  return {
    ...state,
    status: "cancelled",
  };
}
