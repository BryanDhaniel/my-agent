/**
 * Minimal glob to RegExp converter.
 * Supports: "*" within a segment, "**" across segments (a double-star
 * followed by a slash also matches zero directories), "?" for one
 * non-separator char.
 * No brace expansion or character classes — keep it simple on purpose.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "^";
  const n = glob.length;

  for (let i = 0; i < n; i++) {
    const c = glob[i];
    if (c === undefined) break;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        let j = i;
        while (glob[j] === "*") j++;
        if (glob[j] === "/") {
          source += "(?:[^/]+/)*";
          i = j; // loop's i++ skips the slash itself
        } else {
          source += ".*";
          i = j - 1;
        }
        continue;
      }
      source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`${source}$`);
}
