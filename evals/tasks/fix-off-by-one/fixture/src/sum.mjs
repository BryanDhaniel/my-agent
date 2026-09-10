// Returns the sum of all numbers in `items`.
// NOTE: intentionally broken — the loop bound drops the final element.
export function sum(items) {
  let total = 0;
  for (let i = 0; i < items.length - 1; i++) {
    total += items[i];
  }
  return total;
}
