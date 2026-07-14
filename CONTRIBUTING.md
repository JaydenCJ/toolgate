# Contributing to toolgate

Thanks for your interest in improving toolgate. Issues, discussions, and pull
requests are all welcome.

## Development setup

Requirements: Node.js >= 20 and npm.

Get the source:

```bash
git clone https://github.com/JaydenCJ/toolgate.git
cd toolgate
npm install
npm run build     # compile TypeScript to dist/
npm test          # run the vitest unit suite
npm run lint      # ESLint (flat config) over src/, tests/ and the .mjs helpers
npm run smoke     # full end-to-end smoke: stdio + HTTP proxy, approvals, audit
```

The smoke script (`scripts/smoke.sh`) runs entirely offline against
127.0.0.1 and prints `SMOKE OK` when everything passes — please run it before
opening a pull request.

## Project layout

```
src/policy/    policy model, validation, engine (pure logic, no I/O)
src/approval/  pending-approval registry + terminal/Slack notifiers
src/audit/     event schema + JSONL/HTTP/stderr sinks
src/proxy/     JSON-RPC framing, downstream transports, gateway core,
               stdio/HTTP server modes
src/control/   localhost control API (pending/approve/deny)
src/cli.ts     command-line entry point
tests/         vitest suites mirroring the modules above
examples/      demo MCP server + fully commented example policy
```

## Guidelines

- **Keep the engine pure.** `src/policy/engine.ts` must stay free of I/O and
  wall-clock reads (the clock is injected) so decisions remain unit-testable.
- **Every policy behavior needs a test.** New rule types, detectors, or
  decision codes should come with engine tests and, when they affect the wire
  protocol, a gateway test.
- **English code comments only.** README translations (zh/ja) must be updated
  in the same pull request as the English README.
- **No new runtime dependencies without discussion.** The gateway currently
  depends on `yaml` only; the small footprint is a feature.
- **Safe defaults.** Anything that listens must bind 127.0.0.1 unless the
  user explicitly opts out; secrets must never be logged in clear text.

## Reporting security issues

If you believe you found a vulnerability (e.g. a policy bypass), please do
not open a public issue. Use GitHub's private vulnerability reporting on this
repository instead.

## Commit and PR conventions

- One logical change per pull request; include tests.
- Describe the policy semantics change (if any) in the PR body — decision
  order changes are breaking changes for policy authors.
- This repository has no CI; verification is local-only. Run the full
  sequence before requesting review:
  `npm install` → `npm run build` → `npm test` → `npm run lint` →
  `bash scripts/smoke.sh` (must end with `SMOKE OK`).
