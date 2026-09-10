// Square root that should fail clearly on negative input.
// NOTE: buggy — returns a string instead of throwing.
export function safeSqrt(n) {
  if (n < 0) return "NaN";
  return Math.sqrt(n);
}
