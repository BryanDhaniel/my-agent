import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  containsSecrets,
  detectSecrets,
  redactSecrets,
  sanitizeMemoryContent,
} from "./sanitize.js";

/**
 * Assemble a realistic secret from parts. The committed source must never
 * contain a *complete*, push-blocking credential literal — GitHub secret
 * scanning would block the push — so the vendor prefix and the entropy are
 * kept in separate string literals and joined only at runtime, where the
 * sanitizer still sees the real value.
 */
const secret = (...parts: string[]): string => parts.join("");

describe("detectSecrets", () => {
  const secrets: Array<[string, string]> = [
    ["openai key", secret("the key is sk-proj-", "abcdefghijklmnopqrstuvwxyz1234")],
    ["anthropic key", secret("use sk-ant-", "api03-abcdefghijklmnopqrstuvwxyz1234")],
    ["github token", secret("token ghp_", "abcdefghijklmnopqrstuvwxyz1234")],
    ["github fine-grained", secret("github_pat_", "abcdefghijklmnopqrstuvwxyz1234")],
    ["slack token", secret("slack xoxb-", "1234567890-abcdefghijklmnop")],
    ["aws key", secret("aws AKIA", "IOSFODNN7EXAMPLE")],
    ["google key", secret("AIza", "SyD-abc123def456ghi789jkl012mno345pqrs")],
    ["gitlab token", secret("glpat-", "oSiuKqUoOyyJhrU2XS37")],
    ["npm token", secret("npm_", "abcdefghijklmnopqrstuvwxyz0123456789")],
    [
      "private key",
      secret("-----BEGIN ", "RSA PRIVATE KEY", "-----\nMIIEow..."),
    ],
    [
      "jwt",
      secret(
        "bearer e",
        "yJhbGciOiJIUzI1NiJ9",
        ".e",
        "yJzdWIiOiIxMjM0NTY3ODkwIn0",
        ".abc123def456",
      ),
    ],
    ["url credentials", secret("postgres://admin:", "hunter2", "@db.internal:5432/app")],
    ["api key assignment", secret("api_key = sk-", "live-abcdefghijklmnop123456")],
    ["password assignment", secret('password', ': "correct horse battery staple"')],
    ["authorization header", secret("Authorization: Bearer ", "abcdefghijklmnop")],
    ["session token", secret("session_token=", "abcdefghijklmnop")],
    ["client secret", secret("client_secret = ", "abcdefghijklmnop")],
  ];

  for (const [label, text] of secrets) {
    it(`flags ${label}`, () => {
      assert.equal(containsSecrets(text), true, `expected a finding for: ${text}`);
      assert.ok(detectSecrets(text).length > 0);
    });
  }

  it("leaves ordinary project knowledge alone", () => {
    const clean = [
      "The project uses vitest for tests.",
      "Never commit .env.local — it holds OPENAI_API_KEY.",
      "We always use tabs, never spaces.",
      "Sessions live in ~/.my-agent/sessions as JSONL.",
      "src/context/manager.ts owns the token budget.",
    ];
    for (const text of clean) {
      assert.equal(containsSecrets(text), false, `false positive on: ${text}`);
    }
  });
});

describe("sanitizeMemoryContent", () => {
  it("accepts clean content and trims it", () => {
    const result = sanitizeMemoryContent("  We use pnpm here.  ");
    assert.deepEqual(result, { ok: true, content: "We use pnpm here." });
  });

  it("rejects rather than partially cleaning — a missing memory is cheap", () => {
    const result = sanitizeMemoryContent(
      secret("the deploy token is ghp_", "abcdefghijklmnopqrstuvwxyz1234"),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /secret/);
      assert.ok(result.findings.some((f) => f.rule === "github-token"));
    }
  });
});

describe("redactSecrets", () => {
  it("replaces the secret and keeps the surrounding prose", () => {
    const out = redactSecrets(
      secret("api_key = sk-", "live-abcdefghijklmnop123456 is the sandbox key"),
    );
    assert.equal(out, "[REDACTED] is the sandbox key");
  });

  it("is idempotent", () => {
    const once = redactSecrets(secret("ghp_", "abcdefghijklmnopqrstuvwxyz1234"));
    assert.equal(redactSecrets(once), once);
    assert.equal(once, "[REDACTED]");
  });
});
