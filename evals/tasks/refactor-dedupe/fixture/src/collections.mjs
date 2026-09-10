// Removes duplicates from `items`.
// NOTE: buggy — only collapses consecutive duplicates.
export function dedupe(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (out.length === 0 || out[out.length - 1] !== items[i]) {
      out.push(items[i]);
    }
  }
  return out;
}
