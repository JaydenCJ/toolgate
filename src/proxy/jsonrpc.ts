/**
 * Minimal JSON-RPC 2.0 message model plus newline-delimited framing, matching
 * the MCP stdio transport (one JSON object per line, UTF-8).
 *
 * The proxy intentionally treats messages structurally instead of pulling in
 * an MCP SDK: it only needs to recognize `tools/call` and `tools/list`; every
 * other message passes through untouched, which is what keeps toolgate
 * framework-agnostic.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

/** True for messages that expect a response (id + method). */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

/** True for fire-and-forget messages (method, no id). */
export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

/** True for success/error replies (id, no method). */
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcSuccess | JsonRpcError {
  return !("method" in msg) && "id" in msg;
}

/** Standard JSON-RPC error codes used by the gateway. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** Serialize one message in stdio framing (single line + newline). */
export function frameMessage(msg: JsonRpcMessage): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Incremental parser for newline-delimited JSON-RPC streams.
 * Feed it chunks; it invokes `onMessage` per parsed object and
 * `onError` for lines that fail to parse.
 */
export class NdjsonParser {
  private buffer = "";
  private readonly onMessage: (msg: JsonRpcMessage) => void;
  private readonly onError: (line: string, error: Error) => void;

  constructor(
    onMessage: (msg: JsonRpcMessage) => void,
    onError: (line: string, error: Error) => void = () => {},
  ) {
    this.onMessage = onMessage;
    this.onError = onError;
  }

  feed(chunk: string | Buffer): void {
    this.buffer += chunk.toString();
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          this.onMessage(JSON.parse(line) as JsonRpcMessage);
        } catch (err) {
          this.onError(line, err as Error);
        }
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }
}
