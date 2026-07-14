/**
 * Minimal glob matching for tool names.
 * Supports `*` (any run of characters) and `?` (any single character).
 */

const cache = new Map<string, RegExp>();

function compile(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let source = "^";
  for (const ch of glob) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  source += "$";
  const regex = new RegExp(source);
  cache.set(glob, regex);
  return regex;
}

/** True when `name` matches the glob pattern. */
export function globMatch(glob: string, name: string): boolean {
  return compile(glob).test(name);
}

/** True when `name` matches any glob in the list. */
export function globMatchAny(globs: string[], name: string): boolean {
  return globs.some((g) => globMatch(g, name));
}
