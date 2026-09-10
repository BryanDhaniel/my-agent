// NOTE: intentionally broken — drops the final element.
export function sum(items) {
  let total = 0;
  for (let i = 0; i < items.length - 1; i++) {
    total += items[i];
  }
  return total;
}
