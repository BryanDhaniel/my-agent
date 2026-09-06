/**
 * Explicit secret filtering for anything about to become durable.
 *
 * This is deliberately not a clever detector. It matches well-known key
 * shapes and `key = value` assignments for the credentials that actually show
 * up in agent transcripts, and it fails closed: when anything matches, the
 * memory is rejected rather than partially cleaned. A missing memory is cheap;
 * a committed API key is not.
 */

export interface SecretFinding {
  /** Which rule matched — useful in logs and tests. */
  readonly rule: string;
  /** The matched text, never the surrounding content. */
  readonly match: string;
}

export type SanitizeResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: string; readonly findings: readonly SecretFinding[] };

interface SecretRule {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * High-confidence patterns only. Each one either has a recognizable vendor
 * prefix or is an explicit `name = secret` assignment, so ordinary prose about
 * configuration does not trip it.
 */
const SECRET_RULES: readonly SecretRule[] = [
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: "github-fine-grained", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{30,40}\b/g },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  {
    name: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  { name: "credentials-in-url", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi },
  {
    name: "secret-assignment",
    pattern:
      /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer|authorization|client[_-]?secret|secret[_-]?key|private[_-]?key|password|passwd|pwd|session[_-]?token|refresh[_-]?token|credential|credentials)\s*(?::|=|=>)\s*["']?([^\s"',;]{6,})/gi,
  },
];

/** Find every high-confidence secret in `text`. */
export function detectSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of SECRET_RULES) {
    // Rules are module-level constants; reset before reuse.
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      findings.push({ rule: rule.name, match: match[0] });
      if (match[0] === "") rule.pattern.lastIndex++;
    }
  }
  return findings;
}

/** True when the text contains something that must never be persisted. */
export function containsSecrets(text: string): boolean {
  return detectSecrets(text).length > 0;
}

/** Replace every detected secret with a fixed marker. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (whole) => (whole === "" ? whole : "[REDACTED]"));
  }
  return out;
}

/**
 * Gate for anything about to be written to the memory store.
 *
 * Fails closed: any finding rejects the whole memory. Callers that want the
 * cleaned text anyway can use `redactSecrets`, which is why both exist.
 */
export function sanitizeMemoryContent(text: string): SanitizeResult {
  const findings = detectSecrets(text);
  if (findings.length > 0) {
    const rules = [...new Set(findings.map((f) => f.rule))].join(", ");
    return {
      ok: false,
      reason: `refusing to persist content that looks like a secret (${rules})`,
      findings,
    };
  }
  return { ok: true, content: text.trim() };
}
