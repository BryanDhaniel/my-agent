export function capitalize(value) {
  if (value.length === 0) return value;
  return value[0].toUpperCase() + value.slice(1);
}

export function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + "…";
}

export function repeat(value, count) {
  if (count <= 0) return "";
  return Array.from({ length: count }, () => value).join("");
}
