#!/usr/bin/env bash
# Self-asserting smoke test for toolgate. Runs entirely offline against
# 127.0.0.1. Prints "SMOKE OK" and exits 0 only when every check passes.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f dist/cli.js ]; then
  echo "[smoke] dist/ missing, building first..."
  npm run build >/dev/null
fi

WORKDIR=$(mktemp -d)
SERVE_PID=""
# The example policy ships a `./toolgate-audit.jsonl` sink, so gateway runs
# below drop that file into the repo root. Leave the tree exactly as we found
# it: remove the file on exit unless it existed before this run.
ROOT_AUDIT="toolgate-audit.jsonl"
ROOT_AUDIT_PREEXISTS=0
[ -e "$ROOT_AUDIT" ] && ROOT_AUDIT_PREEXISTS=1
cleanup() {
  if [ -n "$SERVE_PID" ] && kill -0 "$SERVE_PID" 2>/dev/null; then
    kill "$SERVE_PID" 2>/dev/null || true
    wait "$SERVE_PID" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
  if [ "$ROOT_AUDIT_PREEXISTS" -eq 0 ]; then
    rm -f "$ROOT_AUDIT"
  fi
}
trap cleanup EXIT

echo "[smoke] 1/6 --version and --help"
node dist/cli.js --version | grep -q "^toolgate 0\.1\.0$"
node dist/cli.js --help | grep -q "^Usage:"

echo "[smoke] 2/6 policy validation (good and bad files)"
node dist/cli.js validate examples/policy.yaml | grep -q ": OK"
printf 'version: 1\nrules:\n  - name: broken\n    match: { tools: [] }\n    action: explode\n' > "$WORKDIR/bad.yaml"
set +e
node dist/cli.js validate "$WORKDIR/bad.yaml" >/dev/null 2>"$WORKDIR/bad.err"
BAD_RC=$?
set -e
[ "$BAD_RC" -ne 0 ]
grep -q "rules\[0\].action" "$WORKDIR/bad.err"

echo "[smoke] 3/6 offline decision check (allow=0 / deny=3 / approve=4)"
node dist/cli.js check --policy examples/policy.yaml --tool get_weather --args '{"city":"Tokyo"}' >/dev/null
set +e
node dist/cli.js check --policy examples/policy.yaml --tool delete_file --args '{"path":"/x"}' > "$WORKDIR/deny.json" 2>/dev/null
DENY_RC=$?
node dist/cli.js check --policy examples/policy.yaml --tool send_payment --args '{"to":"a","amount_usd":1}' >/dev/null 2>&1
APPROVE_RC=$?
set -e
[ "$DENY_RC" -eq 3 ]
[ "$APPROVE_RC" -eq 4 ]
grep -q '"rule": "deny-deletes"' "$WORKDIR/deny.json"

echo "[smoke] 4/6 stdio MCP round trip (initialize -> tools/list -> tools/call, policy + approval + audit)"
node scripts/smoke-client.mjs "$WORKDIR/audit.jsonl"

echo "[smoke] 5/6 HTTP mode: /health + policy enforcement over POST /mcp"
HTTP_PORT=$(( (RANDOM % 20000) + 30000 ))
CONTROL_PORT=$(( HTTP_PORT + 1 ))
node dist/cli.js serve --policy examples/policy.yaml --port "$HTTP_PORT" --control-port "$CONTROL_PORT" \
  --audit-log "$WORKDIR/serve-audit.jsonl" \
  -- node examples/demo-server.mjs 2>"$WORKDIR/serve.log" &
SERVE_PID=$!
for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:${HTTP_PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -sf "http://127.0.0.1:${HTTP_PORT}/health" | grep -q '"status":"ok"'
curl -sf -X POST "http://127.0.0.1:${HTTP_PORT}/mcp" \
  -H 'content-type: application/json' -H 'mcp-session-id: smoke-http' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | grep -q '"toolgate-demo-server"'
curl -sf -X POST "http://127.0.0.1:${HTTP_PORT}/mcp" \
  -H 'content-type: application/json' -H 'mcp-session-id: smoke-http' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"delete_file","arguments":{"path":"/x"}}}' \
  | grep -q '"deny-deletes"\|deny-deletes'
kill "$SERVE_PID"
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""

echo "[smoke] 6/6 docker compose config validation (skipped when docker is unavailable)"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose config --quiet
  echo "[smoke] compose file is valid"
else
  echo "[smoke] docker not available; compose validation skipped"
fi

echo "SMOKE OK"
