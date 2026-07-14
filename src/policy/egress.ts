/**
 * Data-egress detectors: find and mask sensitive material in tool-call
 * arguments (request direction) and tool results (response direction).
 *
 * Detection runs on strings; structured arguments are walked recursively so
 * redaction preserves the argument shape.
 */

/** Names of the built-in detectors. */
export const BUILTIN_DETECTORS = {
  /** RFC-5322-ish email addresses. */
  "email": /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /** AWS access key IDs (long-term AKIA / temporary ASIA). */
  "aws-access-key": /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /** PEM private key headers (RSA, EC, OpenSSH, PKCS#8...). */
  "private-key": /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  /** Common API-key shapes such as sk-... / rk-... tokens. */
  "api-key": /\b[sr]k-[A-Za-z0-9_-]{20,}\b/g,
  /** JSON Web Tokens (three base64url segments starting with eyJ). */
  "jwt": /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /** GitHub personal access tokens (classic and fine-grained). */
  "github-token": /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  /** IPv4 addresses. */
  "ipv4": /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
} as const;

export type BuiltinDetectorName = keyof typeof BUILTIN_DETECTORS;

/** True when `name` refers to a built-in detector. */
export function isKnownDetector(name: string): name is BuiltinDetectorName {
  return Object.prototype.hasOwnProperty.call(BUILTIN_DETECTORS, name);
}

/** A compiled pattern ready for scanning. */
export interface CompiledPattern {
  /** Detector name or the raw `regex:` entry (used in labels/audit). */
  name: string;
  regex: RegExp;
}

/**
 * Compile a policy pattern entry into a scanning regex.
 * Accepts a built-in detector name or `regex:<source>`.
 * Throws on unknown detector names or invalid regex sources.
 */
export function compileEgressPattern(entry: string): CompiledPattern {
  if (entry.startsWith("regex:")) {
    const source = entry.slice("regex:".length);
    // Fresh RegExp per compile; "g" is required for multi-hit scans.
    return { name: entry, regex: new RegExp(source, "g") };
  }
  if (!isKnownDetector(entry)) {
    throw new Error(`unknown egress detector "${entry}"`);
  }
  return { name: entry, regex: new RegExp(BUILTIN_DETECTORS[entry].source, "g") };
}

/** One detector's findings inside a scanned payload. */
export interface EgressHit {
  detector: string;
  count: number;
}

/** Scan a string against compiled patterns and count hits per detector. */
export function scanText(text: string, patterns: CompiledPattern[]): EgressHit[] {
  const hits: EgressHit[] = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    const matches = text.match(pattern.regex);
    if (matches && matches.length > 0) {
      hits.push({ detector: pattern.name, count: matches.length });
    }
  }
  return hits;
}

/** Replace every match with `[REDACTED:<detector>]`. */
export function redactText(text: string, patterns: CompiledPattern[]): { text: string; hits: EgressHit[] } {
  let out = text;
  const hits: EgressHit[] = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    let count = 0;
    out = out.replace(pattern.regex, () => {
      count += 1;
      return `[REDACTED:${labelFor(pattern.name)}]`;
    });
    if (count > 0) hits.push({ detector: pattern.name, count });
  }
  return { text: out, hits };
}

function labelFor(name: string): string {
  return name.startsWith("regex:") ? "custom" : name;
}

/**
 * Recursively scan every string in a JSON-like value.
 * Object keys are scanned too, since keys can leak data.
 */
export function scanValue(value: unknown, patterns: CompiledPattern[]): EgressHit[] {
  const totals = new Map<string, number>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      for (const hit of scanText(v, patterns)) {
        totals.set(hit.detector, (totals.get(hit.detector) ?? 0) + hit.count);
      }
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (typeof v === "object" && v !== null) {
      for (const [key, val] of Object.entries(v)) {
        visit(key);
        visit(val);
      }
    }
  };
  visit(value);
  return [...totals.entries()].map(([detector, count]) => ({ detector, count }));
}

/**
 * Recursively redact every string in a JSON-like value, returning a deep copy
 * with matches replaced. The input value is never mutated.
 */
export function redactValue(value: unknown, patterns: CompiledPattern[]): { value: unknown; hits: EgressHit[] } {
  const totals = new Map<string, number>();
  const record = (hits: EgressHit[]): void => {
    for (const hit of hits) {
      totals.set(hit.detector, (totals.get(hit.detector) ?? 0) + hit.count);
    }
  };
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      const result = redactText(v, patterns);
      record(result.hits);
      return result.text;
    }
    if (Array.isArray(v)) return v.map(visit);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(v)) {
        out[key] = visit(val);
      }
      return out;
    }
    return v;
  };
  const redacted = visit(value);
  return { value: redacted, hits: [...totals.entries()].map(([detector, count]) => ({ detector, count })) };
}
