/**
 * Stdio proxy mode (`toolgate run`): the MCP client talks to toolgate over
 * stdin/stdout exactly as it would talk to the wrapped server. One process
 * equals one MCP session equals one budget "task".
 */

import type { Readable, Writable } from "node:stream";
import { frameMessage, NdjsonParser, type JsonRpcMessage } from "./jsonrpc.js";
import type { Gateway } from "./gateway.js";

export interface StdioBridgeOptions {
  gateway: Gateway;
  sessionId: string;
  input?: Readable;
  output?: Writable;
}

/** Wire a gateway to stdio streams. Returns a stop function. */
export function attachStdio(options: StdioBridgeOptions): { stop: () => void } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const respond = (msg: JsonRpcMessage): void => {
    output.write(frameMessage(msg));
  };
  options.gateway.setClientBroadcast(respond);

  const parser = new NdjsonParser(
    (msg) => options.gateway.handleClientMessage(msg, options.sessionId, respond),
    (line, error) => {
      process.stderr.write(`[toolgate] invalid JSON from client (${error.message}): ${line.slice(0, 120)}\n`);
    },
  );
  const onData = (chunk: Buffer): void => parser.feed(chunk);
  input.on("data", onData);
  return {
    stop: () => {
      input.off("data", onData);
    },
  };
}
