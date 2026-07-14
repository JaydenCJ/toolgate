# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-07-08 (unreleased)

### Added

- Policy engine evaluating every MCP `tools/call` in a fixed order:
  circuit breaker → request egress → rate limits → budget → action rules
  (`allow` / `deny` / `approve`), with glob tool matching and regex argument
  matchers.
- Per-task budget circuit breaker (`budget.max_calls` / `budget.max_cost`)
  with a per-tool cost table; once tripped, the whole session stays blocked.
- Sliding-window per-tool rate limits.
- Data-egress rules on both directions: `deny` blocks the call/response,
  `redact` masks matches in place. Built-in detectors: `email`,
  `aws-access-key`, `private-key`, `api-key`, `jwt`, `github-token`, `ipv4`,
  plus custom `regex:` patterns.
- Human approval flow: `action: approve` parks the call; terminal cards and
  Slack incoming-webhook notifications; decisions via the localhost control
  API and the `toolgate pending|approve|deny` commands; configurable timeout
  with `on_timeout: deny|allow`.
- Audit event stream (`toolgate.audit.v1`): JSONL file, HTTP (SIEM webhook),
  and stderr sinks; arguments logged as SHA-256 hashes by default.
- Stdio proxy mode (`toolgate run`) and Streamable HTTP mode
  (`toolgate serve` with `POST /mcp` + `GET /health`), both binding
  127.0.0.1 by default; downstream over stdio or Streamable HTTP.
- Optional `tools/list` filtering that hides statically denied tools.
- CLI: `run`, `serve`, `check` (offline dry-run with meaningful exit codes),
  `validate` (path-precise policy errors), `init`, `pending`, `approve`,
  `deny`.
- Example policy and demo MCP server, docker-compose deployment with named
  audit volume and healthcheck, vitest unit suite, and a self-asserting
  offline smoke script.
- `docs/live-flow.md`: a captured end-to-end session against a running
  gateway — proxy → parked approval → human decision → audit JSONL — with
  verbatim output from a real run.
- ESLint flat config (`eslint.config.mjs`, `@eslint/js` +
  `typescript-eslint` recommended) and an `npm run lint` script, part of
  the documented local verification sequence (see CONTRIBUTING.md).

<!-- Release-tag links are added when the project moves to its standalone
     repository and v0.1.0 is actually tagged and published. -->
