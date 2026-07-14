# Live flow: proxy → approval → audit

A captured end-to-end session against a real running gateway. Everything below
is verbatim output from one run on 2026-07-08 (Linux, Node v22.22.2), using the
demo MCP server that ships in this repository. No output was edited except the
`===` section markers. To reproduce, build the project (see the README
Quickstart), then run the commands in order from the repository root.

The same policy checks run identically in stdio mode (`toolgate run`); HTTP
mode (`toolgate serve`) is used here because every step is a copy-pasteable
`curl` command.

## 1. Start the gateway in front of a real MCP server

Terminal A — the gateway wraps `examples/demo-server.mjs` (a stdio MCP server)
and exposes it as a Streamable HTTP endpoint:

```bash
toolgate serve --policy examples/policy.yaml --port 8848 --control-port 9848 \
  --audit-log ./live-audit.jsonl -- node examples/demo-server.mjs
```

Gateway stderr on startup:

```text
[toolgate] control api listening on http://127.0.0.1:9848
[toolgate] mcp endpoint listening on http://127.0.0.1:8848/mcp
[toolgate] gateway ready (policy: examples/policy.yaml, control: http://127.0.0.1:9848)
```

Health check:

```bash
$ curl -s http://127.0.0.1:8848/health
{"status":"ok"}
```

## 2. The MCP handshake reaches the downstream server

Terminal B plays the agent. `initialize` passes through the gateway untouched
and is answered by the demo server itself:

```bash
$ curl -s -X POST http://127.0.0.1:8848/mcp \
    -H 'content-type: application/json' -H 'mcp-session-id: demo-task-1' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"toolgate-demo-server","version":"0.1.0"}}}
```

## 3. An allowed call goes end to end

`get_weather` matches no restrictive rule, so the gateway forwards it and the
downstream result comes back:

```bash
$ curl -s -X POST http://127.0.0.1:8848/mcp \
    -H 'content-type: application/json' -H 'mcp-session-id: demo-task-1' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_weather","arguments":{"city":"Tokyo"}}}'
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Weather in Tokyo: 24C, clear skies, wind 8 km/h (demo data)."}],"isError":false}}
```

## 4. A denied call is answered by the gateway, not the server

`delete_file` hits the `deny-deletes` rule. The demo server never sees the
call; the agent gets a plain-language reason as an `isError` tool result:

```bash
$ curl -s -X POST http://127.0.0.1:8848/mcp \
    -H 'content-type: application/json' -H 'mcp-session-id: demo-task-1' \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delete_file","arguments":{"path":"/etc/passwd"}}}'
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Toolgate blocked this call (rule_deny) [rule: deny-deletes]: destructive file operations are not allowed for this agent"}],"isError":true}}
```

## 5. A payment is parked until a human decides

`send_payment` matches the `approve-payments` rule. The HTTP request from
step B **blocks** while the call is parked, and the gateway prints an approval
card on its stderr (Terminal A):

```bash
$ curl -s -X POST http://127.0.0.1:8848/mcp \
    -H 'content-type: application/json' -H 'mcp-session-id: demo-task-1' \
    -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"send_payment","arguments":{"to":"acme-corp","amount_usd":120}}}'
# ... blocks, waiting for a human ...
```

Terminal A, at the same moment:

```text
+--------------------------- APPROVAL REQUIRED ---------------------------+
| tool:    send_payment
| args:    {"to":"acme-corp","amount_usd":120}
| rule:    approve-payments (payments move real money and always need a human decision)
| session: demo-task-1
| expires: in 120s
|
|   toolgate approve apr_be947aded6ba --control-url http://127.0.0.1:9848
|   toolgate deny apr_be947aded6ba --control-url http://127.0.0.1:9848
+--------------------------------------------------------------------------+
```

## 6. A human approves from a third terminal

Terminal C — list and resolve via the control API on 127.0.0.1:

```bash
$ toolgate pending
apr_be947aded6ba  send_payment  expires in 118s  args {"to":"acme-corp","amount_usd":120}

$ toolgate approve apr_be947aded6ba
apr_be947aded6ba: approved
```

The blocked request from step 5 now returns with the downstream result:

```text
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"Payment of $120 to acme-corp submitted (demo, no real transfer)."}],"isError":false}}
```

(With the Slack notifier enabled in the policy, the same card also lands in a
Slack channel via an incoming webhook; the decision path is identical.)

## 7. The audit trail has every decision

`./live-audit.jsonl` after the session — one structured event per decision,
arguments recorded as SHA-256 hashes:

```json
{"schema":"toolgate.audit.v1","ts":"2026-07-08T18:00:30.603Z","event":"gateway_started","mode":"http","policy_path":"examples/policy.yaml"}
{"schema":"toolgate.audit.v1","ts":"2026-07-08T18:00:30.652Z","event":"tool_call","session_id":"demo-task-1","tool":"get_weather","decision":"allow","args_sha256":"40ed420b2bf58d0e736683466f50e24b4c902ccc93df74db423dc6cb6baa326a","duration_ms":1,"budget":{"calls_used":1,"cost_used":0.01,"max_calls":50,"max_cost":2},"cost":0.01}
{"schema":"toolgate.audit.v1","ts":"2026-07-08T18:00:30.661Z","event":"tool_call","session_id":"demo-task-1","tool":"delete_file","decision":"deny","args_sha256":"8976783d93a2000a234cf7e87969f49d7e5e14cc8a99fec4d2d84fd82d393887","duration_ms":0,"budget":{"calls_used":1,"cost_used":0.01,"max_calls":50,"max_cost":2},"rule":"deny-deletes","deny_code":"rule_deny","reason":"destructive file operations are not allowed for this agent"}
{"schema":"toolgate.audit.v1","ts":"2026-07-08T18:00:30.670Z","event":"approval_requested","session_id":"demo-task-1","approval_id":"apr_be947aded6ba","tool":"send_payment","rule":"approve-payments","timeout_seconds":120}
{"schema":"toolgate.audit.v1","ts":"2026-07-08T18:00:32.731Z","event":"approval_resolved","session_id":"demo-task-1","approval_id":"apr_be947aded6ba","tool":"send_payment","outcome":"approved","resolved_by":"control-api"}
{"schema":"toolgate.audit.v1","ts":"2026-07-08T18:00:32.731Z","event":"tool_call","session_id":"demo-task-1","tool":"send_payment","decision":"allow","args_sha256":"d52557b6191587aeb6e79871230c6f86748e5d86c10b012b7944f766d8018452","duration_ms":2062,"budget":{"calls_used":2,"cost_used":0.51,"max_calls":50,"max_cost":2},"rule":"approve-payments","cost":0.5}
```

Note the last line: `duration_ms: 2062` is the wall time the payment call
spent parked while the human decided, and the session budget advanced from
`cost_used: 0.01` to `0.51` (payments cost 0.5 units in the example policy).

## Going further

- The self-asserting version of this flow — plus request-egress blocking,
  rate limiting, and response redaction — runs on every `bash scripts/smoke.sh`
  (see `scripts/smoke-client.mjs`, which drives the stdio proxy the same way).
- `examples/policy.yaml` is the fully commented policy used above.
- The README Policy reference section documents every rule field.
