// Runs async tasks and collects their results.
// NOTE: buggy — iterates from the end, so results come back reversed.
export async function runTasks(tasks) {
  const results = [];
  for (let i = tasks.length - 1; i >= 0; i--) {
    results.push(await tasks[i]());
  }
  return results;
}
