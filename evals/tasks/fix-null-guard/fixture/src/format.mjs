// Returns an uppercased, trimmed name.
// NOTE: intentionally broken — it throws on nullish input.
export function formatName(name) {
  return name.trim().toUpperCase();
}
