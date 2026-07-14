import { describe, expect, it } from "vitest";
import { frameMessage, isNotification, isRequest, isResponse, NdjsonParser } from "../src/proxy/jsonrpc.js";
import { parseSseMessages } from "../src/proxy/downstream.js";
import { globMatch } from "../src/policy/glob.js";
import type { JsonRpcMessage } from "../src/proxy/jsonrpc.js";

describe("NdjsonParser", () => {
  it("parses messages split across arbitrary chunk boundaries", () => {
    const seen: JsonRpcMessage[] = [];
    const parser = new NdjsonParser((msg) => seen.push(msg));
    const wire = `${frameMessage({ jsonrpc: "2.0", id: 1, method: "a" })}${frameMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "b",
    })}`;
    for (const char of wire) parser.feed(char);
    expect(seen).toHaveLength(2);
    expect((seen[1] as { method: string }).method).toBe("b");
  });

  it("reports bad lines without dying and skips blanks", () => {
    const seen: JsonRpcMessage[] = [];
    const errors: string[] = [];
    const parser = new NdjsonParser(
      (msg) => seen.push(msg),
      (line) => errors.push(line),
    );
    parser.feed('not json\n\n{"jsonrpc":"2.0","id":3,"method":"ok"}\n');
    expect(errors).toEqual(["not json"]);
    expect(seen).toHaveLength(1);
  });
});

describe("message classification", () => {
  it("distinguishes requests, notifications, and responses", () => {
    expect(isRequest({ jsonrpc: "2.0", id: 1, method: "m" })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", method: "m" })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
    expect(isRequest({ jsonrpc: "2.0", method: "m" })).toBe(false);
    expect(isResponse({ jsonrpc: "2.0", id: 1, method: "m" })).toBe(false);
  });
});

describe("parseSseMessages", () => {
  it("extracts JSON-RPC messages from data lines", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\ndata: keep-alive\n\n';
    const messages = parseSseMessages(body);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 1 });
  });
});

describe("globMatch", () => {
  it("supports * and ? and escapes regex metacharacters", () => {
    expect(globMatch("delete_*", "delete_file")).toBe(true);
    expect(globMatch("delete_*", "undelete_file")).toBe(false);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "ac")).toBe(false);
    expect(globMatch("exact.name", "exact.name")).toBe(true);
    expect(globMatch("exact.name", "exactXname")).toBe(false);
    expect(globMatch("*", "anything")).toBe(true);
  });
});
