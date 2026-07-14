/**
 * toolgate — policy-as-code authorization gateway for AI agent tool calls.
 *
 * Public library surface: the policy engine, loaders, approvals, audit
 * primitives, and the gateway/transport building blocks used by the CLI.
 * Importing this module has no side effects.
 */

export type {
  PolicyDocument,
  PolicyRule,
  RuleMatch,
  RuleAction,
  RateLimitConfig,
  EgressRuleConfig,
  BudgetConfig,
  ApprovalsConfig,
  ApprovalNotifierConfig,
  AuditConfig,
  AuditSinkConfig,
  PolicyOptions,
} from "./policy/types.js";
export { parsePolicy, loadPolicyFile } from "./policy/loader.js";
export { validatePolicy, assertPolicy, formatIssues, type PolicyIssue } from "./policy/validate.js";
export {
  PolicyEngine,
  type Decision,
  type DenyCode,
  type BudgetSnapshot,
  type ResponseVerdict,
  type ResponseValueVerdict,
} from "./policy/engine.js";
export { globMatch, globMatchAny } from "./policy/glob.js";
export {
  BUILTIN_DETECTORS,
  compileEgressPattern,
  scanText,
  redactText,
  scanValue,
  redactValue,
  isKnownDetector,
  type CompiledPattern,
  type EgressHit,
} from "./policy/egress.js";
export {
  ApprovalManager,
  previewArgs,
  type ApprovalNotifier,
  type ApprovalOutcome,
  type ApprovalResult,
  type PendingApproval,
} from "./approval/manager.js";
export { TerminalNotifier } from "./approval/terminal.js";
export { SlackNotifier, type SlackNotifierOptions } from "./approval/slack.js";
export {
  AuditLogger,
  JsonlSink,
  HttpSink,
  StderrSink,
  sinksFromConfig,
  type AuditSink,
} from "./audit/logger.js";
export { hashArgs, nowIso, type AuditEvent, type AuditEventType, type ToolCallEvent } from "./audit/events.js";
export { Gateway, type GatewayOptions, type Respond } from "./proxy/gateway.js";
export {
  StdioDownstream,
  HttpDownstream,
  parseSseMessages,
  type Downstream,
} from "./proxy/downstream.js";
export {
  NdjsonParser,
  frameMessage,
  isRequest,
  isNotification,
  isResponse,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcId,
} from "./proxy/jsonrpc.js";
export { attachStdio } from "./proxy/stdio-server.js";
export { McpHttpServer } from "./proxy/http-server.js";
export { ControlServer } from "./control/server.js";
export { createRuntime, newSessionId, type Runtime, type RuntimeOptions } from "./runtime.js";
