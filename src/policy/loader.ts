/** Load a policy YAML file from disk and validate it. */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { PolicyDocument } from "./types.js";
import { assertPolicy } from "./validate.js";

/** Parse and validate a policy from a YAML source string. */
export function parsePolicy(source: string): PolicyDocument {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch (err) {
    throw new Error(`policy is not valid YAML: ${(err as Error).message}`, { cause: err });
  }
  return assertPolicy(doc);
}

/** Read, parse, and validate a policy file. */
export function loadPolicyFile(path: string): PolicyDocument {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read policy file ${path}: ${(err as Error).message}`, { cause: err });
  }
  return parsePolicy(source);
}
