import type { AgentTask, TaskExecutionPlan } from "./types.js";

/**
 * Plan validation and DAG helpers.
 *
 * A plan is validated once, before anything runs: a rejected plan never
 * starts a single sub-agent.
 */

export interface PlanValidation {
  ok: boolean;
  errors: string[];
}

/** Guards against an accidental explosion of concurrent sub-agents. */
export const MAX_TASKS_PER_PLAN = 20;
export const MAX_CONCURRENCY = 8;

export function validatePlan(plan: TaskExecutionPlan): PlanValidation {
  const errors: string[] = [];
  const tasks = plan.tasks;

  if (tasks.length === 0) {
    return { ok: false, errors: ["plan has no tasks"] };
  }
  if (tasks.length > MAX_TASKS_PER_PLAN) {
    errors.push(`plan has ${tasks.length} tasks; at most ${MAX_TASKS_PER_PLAN} are allowed`);
  }

  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.id === undefined || task.id === "") {
      errors.push("a task is missing an id");
      continue;
    }
    if (ids.has(task.id)) {
      errors.push(`duplicate task id "${task.id}"`);
    }
    ids.add(task.id);

    if (task.task === undefined || task.task.trim() === "") {
      errors.push(`task "${task.id}" is missing a task description`);
    }
  }

  for (const task of tasks) {
    for (const dep of task.dependencies ?? []) {
      if (dep === task.id) {
        errors.push(`task "${task.id}" depends on itself`);
      } else if (!ids.has(dep)) {
        errors.push(`task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }

  const cycle = findCycle(tasks);
  if (cycle !== undefined) {
    errors.push(`dependency cycle: ${cycle.join(" → ")}`);
  }

  if (plan.maxConcurrency !== undefined && plan.maxConcurrency < 1) {
    errors.push("maxConcurrency must be at least 1");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Returns the node sequence of the first cycle found, or undefined when the
 * graph is acyclic. Iterative DFS so a pathological graph cannot blow the
 * stack.
 */
export function findCycle(tasks: AgentTask[]): string[] | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>(tasks.map((t) => [t.id, WHITE]));

  for (const root of tasks) {
    if (colour.get(root.id) !== WHITE) continue;

    const stack: Array<{ id: string; next: number }> = [{ id: root.id, next: 0 }];
    const path: string[] = [root.id];
    colour.set(root.id, GREY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const task = byId.get(frame.id);
      const deps = task?.dependencies ?? [];

      if (frame.next >= deps.length) {
        colour.set(frame.id, BLACK);
        stack.pop();
        path.pop();
        continue;
      }

      const dep = deps[frame.next];
      frame.next++;
      if (dep === undefined) continue;

      const depColour = colour.get(dep) ?? BLACK;
      if (depColour === GREY) {
        const start = path.indexOf(dep);
        return [...path.slice(start === -1 ? 0 : start), dep];
      }
      if (depColour === WHITE) {
        colour.set(dep, GREY);
        stack.push({ id: dep, next: 0 });
        path.push(dep);
      }
    }
  }

  return undefined;
}

/** Tasks whose dependencies have all completed. */
export function readyTasks(
  tasks: AgentTask[],
  statusOf: (id: string) => string | undefined,
): AgentTask[] {
  return tasks.filter((task) =>
    (task.dependencies ?? []).every((dep) => statusOf(dep) === "completed"),
  );
}
