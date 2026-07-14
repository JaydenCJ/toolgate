import { describe, expect, it } from "vitest";
import {
  compileEgressPattern,
  redactText,
  redactValue,
  scanText,
  scanValue,
} from "../src/policy/egress.js";

const emails = [compileEgressPattern("email")];

describe("built-in detectors", () => {
  it("finds AWS access keys", () => {
    const patterns = [compileEgressPattern("aws-access-key")];
    expect(scanText("token AKIAIOSFODNN7EXAMPLE here", patterns)).toEqual([
      { detector: "aws-access-key", count: 1 },
    ]);
    expect(scanText("nothing to see", patterns)).toEqual([]);
  });

  it("finds private key headers, api keys, jwt, github tokens", () => {
    const cases: [string, string][] = [
      ["private-key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
      ["api-key", "sk-abcdefghijklmnopqrstuvwx1234"],
      ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh123456"],
      ["github-token", `ghp_${"a1B2".repeat(9)}`],
    ];
    for (const [detector, sample] of cases) {
      const patterns = [compileEgressPattern(detector)];
      expect(scanText(`x ${sample} y`, patterns), detector).toEqual([{ detector, count: 1 }]);
    }
  });

  it("supports custom regex patterns and rejects invalid ones", () => {
    const custom = [compileEgressPattern("regex:ACME-\\d{4}")];
    expect(scanText("ticket ACME-1234", custom)).toEqual([{ detector: "regex:ACME-\\d{4}", count: 1 }]);
    expect(() => compileEgressPattern("regex:(")).toThrow();
    expect(() => compileEgressPattern("no-such-detector")).toThrow(/unknown egress detector/);
  });
});

describe("redaction", () => {
  it("masks matches with a labeled redaction marker", () => {
    const { text, hits } = redactText("mail a@b.example and c@d.example", emails);
    expect(text).toBe("mail [REDACTED:email] and [REDACTED:email]");
    expect(hits).toEqual([{ detector: "email", count: 2 }]);
  });

  it("labels custom regex redactions as custom", () => {
    const { text } = redactText("ACME-9999", [compileEgressPattern("regex:ACME-\\d{4}")]);
    expect(text).toBe("[REDACTED:custom]");
  });

  it("walks nested structures without mutating the input", () => {
    const input = { user: { email: "a@b.example" }, list: ["x", "c@d.example"] };
    const { value, hits } = redactValue(input, emails);
    expect(input.user.email).toBe("a@b.example");
    expect((value as typeof input).user.email).toBe("[REDACTED:email]");
    expect((value as typeof input).list[1]).toBe("[REDACTED:email]");
    expect(hits).toEqual([{ detector: "email", count: 2 }]);
  });

  it("scans object keys too", () => {
    expect(scanValue({ "a@b.example": true }, emails)).toEqual([{ detector: "email", count: 1 }]);
  });
});
