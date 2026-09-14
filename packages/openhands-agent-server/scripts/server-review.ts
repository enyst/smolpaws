/**
 * Server review records: machine-checked evidence that every upstream agent-server change in a vendored
 * SDK interval received exactly one disposition here (see TRANSPILE_RULES.md, "Server review records").
 *
 * Inputs are the SDK's interval inventories, shipped inside the vendored package
 * (`vendor/openhands-agent/transpile/updates/<from8>..<to8>.inventory.json`), and this package's own
 * records (`transpile/updates/<from8>..<to8>.json` + `.md`). The validator is pure so it can be tested
 * without touching the filesystem; `check-server-review.ts` wires it to the real files.
 */
import { createHash } from 'node:crypto';

export const SERVER_DISPOSITIONS = ['PORT', 'NO_TARGET_CHANGE', 'DEVIATION', 'EXCLUDED', 'DEFERRED'] as const;
export type ServerDisposition = (typeof SERVER_DISPOSITIONS)[number];

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface InventoryCommit {
  readonly sha: string;
  readonly subject: string;
  readonly units: Readonly<Record<string, unknown>>;
}

export interface DriftInventory {
  /** The inventory exactly as parsed from disk; the review hash is computed over this, as the SDK does. */
  readonly raw: unknown;
  readonly repository: string;
  readonly from: string;
  readonly to: string;
  readonly commits: readonly InventoryCommit[];
}

export interface ServerReviewItem {
  readonly disposition: ServerDisposition;
  readonly policy: string | null;
  readonly reason: string;
  readonly tracking: readonly string[];
  readonly evidence: readonly string[];
}

export interface ServerReviewRecord {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly from: string;
  readonly to: string;
  readonly inventorySha256: string;
  readonly items: Readonly<Record<string, ServerReviewItem>>;
}

export interface ManifestPolicy {
  readonly id: string;
  readonly kind: string;
  readonly target: string;
}

export interface ServerReviewContext {
  readonly policies: readonly ManifestPolicy[];
  /** Whether a PORT evidence path exists, relative to the package root. */
  readonly evidenceExists: (relativePath: string) => boolean;
}

/** Same construction as the SDK's `inventoryHash`: sha256 of the compact JSON plus a trailing newline. */
export function inventoryHash(inventory: unknown): string {
  return createHash('sha256').update(`${JSON.stringify(inventory)}\n`).digest('hex');
}

export function intervalName(from: string, to: string): string {
  return `${from.slice(0, 8)}..${to.slice(0, 8)}`;
}

export function serverUnitKeys(inventory: DriftInventory): string[] {
  return inventory.commits.filter((commit) => 'server' in commit.units).map((commit) => `${commit.sha}:server`);
}

export function parseInventory(raw: unknown, label: string): DriftInventory {
  const root = object(raw, label);
  const commits = Array.isArray(root.commits) ? root.commits : fail(`${label}.commits must be an array`);
  return {
    raw,
    repository: string(root.repository, `${label}.repository`),
    from: sha(root.from, `${label}.from`),
    to: sha(root.to, `${label}.to`),
    commits: commits.map((value, index) => {
      const commit = object(value, `${label}.commits[${index}]`);
      return {
        sha: sha(commit.sha, `${label}.commits[${index}].sha`),
        subject: string(commit.subject, `${label}.commits[${index}].subject`),
        units: object(commit.units, `${label}.commits[${index}].units`),
      };
    }),
  };
}

export function parseServerReview(raw: unknown, label: string): ServerReviewRecord {
  const root = object(raw, label);
  if (root.schemaVersion !== 1) fail(`${label}.schemaVersion must equal 1`);
  const items: Record<string, ServerReviewItem> = {};
  for (const [key, value] of Object.entries(object(root.items, `${label}.items`))) {
    const item = object(value, `${label}.items.${key}`);
    const disposition = string(item.disposition, `${label}.items.${key}.disposition`);
    if (!(SERVER_DISPOSITIONS as readonly string[]).includes(disposition)) {
      fail(`${label}.items.${key}.disposition has an invalid value`);
    }
    items[key] = {
      disposition: disposition as ServerDisposition,
      policy: item.policy === null || item.policy === undefined ? null : string(item.policy, `${label}.items.${key}.policy`),
      reason: string(item.reason, `${label}.items.${key}.reason`),
      tracking: stringArray(item.tracking ?? [], `${label}.items.${key}.tracking`),
      evidence: stringArray(item.evidence ?? [], `${label}.items.${key}.evidence`),
    };
  }
  const hash = string(root.inventorySha256, `${label}.inventorySha256`);
  if (!SHA256.test(hash)) fail(`${label}.inventorySha256 must be a SHA-256 hash`);
  return {
    schemaVersion: 1,
    repository: string(root.repository, `${label}.repository`),
    from: sha(root.from, `${label}.from`),
    to: sha(root.to, `${label}.to`),
    inventorySha256: hash,
    items,
  };
}

/** Every finding is an error; an empty list means the record fully covers the inventory. */
export function validateServerReview(
  review: ServerReviewRecord,
  inventory: DriftInventory,
  context: ServerReviewContext,
): string[] {
  const errors: string[] = [];
  const name = intervalName(inventory.from, inventory.to);
  if (review.repository !== inventory.repository) errors.push(`${name}: review.repository does not match the inventory`);
  if (review.from !== inventory.from) errors.push(`${name}: review.from does not match the inventory`);
  if (review.to !== inventory.to) errors.push(`${name}: review.to does not match the inventory`);
  if (review.inventorySha256 !== inventoryHash(inventory.raw)) errors.push(`${name}: review inventory hash is stale`);

  const expected = new Set(serverUnitKeys(inventory));
  for (const key of expected) if (!(key in review.items)) errors.push(`${name}: missing review item ${key}`);
  for (const key of Object.keys(review.items)) {
    if (!expected.has(key)) errors.push(`${name}: stale or unknown review item ${key}`);
  }

  for (const [key, item] of Object.entries(review.items)) {
    if (!expected.has(key)) continue;
    if (item.reason.trim().length < 4) errors.push(`${key} needs a concrete reason`);
    if (item.disposition === 'DEVIATION' || item.disposition === 'EXCLUDED') {
      if (item.policy === null) {
        errors.push(`${key} must reference a policy ID`);
      } else {
        const policy = context.policies.find((candidate) => candidate.id === item.policy);
        if (policy === undefined) errors.push(`${key} references unknown policy ${item.policy}`);
        else if (policy.kind !== item.disposition) errors.push(`${key} policy ${item.policy} is ${policy.kind}, not ${item.disposition}`);
        else if (item.disposition === 'DEVIATION' && policy.target !== 'server') {
          errors.push(`${key} policy ${item.policy} belongs to ${policy.target}, not server`);
        }
      }
    } else if (item.policy !== null) {
      errors.push(`${key} must not attach policy ${item.policy} to ${item.disposition}`);
    }
    if (item.disposition === 'DEFERRED' && item.tracking.length === 0) {
      errors.push(`${key} DEFERRED work needs a tracking item`);
    }
    if (item.disposition === 'PORT') {
      if (item.evidence.length === 0) errors.push(`${key} PORT work needs TypeScript test evidence`);
      for (const path of item.evidence) {
        if (!context.evidenceExists(path)) errors.push(`${key} evidence ${path} does not exist`);
      }
    }
  }
  return errors;
}

/**
 * Walk the vendored inventories from `since` to the vendored pin. Every hop must have an inventory
 * (the SDK generates one per interval) and the chain must end exactly at the pin, so a re-vendor
 * cannot skip a review.
 */
export function intervalChain(since: string, pin: string, inventories: readonly DriftInventory[]): DriftInventory[] {
  const chain: DriftInventory[] = [];
  let cursor = since;
  const seen = new Set<string>();
  while (cursor !== pin) {
    const candidates = inventories.filter((inventory) => inventory.from === cursor);
    const targets = new Set(candidates.map((inventory) => inventory.to));
    if (candidates.length === 0) {
      fail(`no vendored inventory continues from ${cursor.slice(0, 8)}; the chain must reach the vendored pin ${pin.slice(0, 8)}`);
    }
    if (targets.size > 1) {
      fail(`vendored inventories fork at ${cursor.slice(0, 8)} (${[...targets].map((to) => to.slice(0, 8)).join(', ')}); the chain to the pin must be unambiguous`);
    }
    if (seen.has(cursor)) fail('vendored inventories form a cycle');
    seen.add(cursor);
    const next = candidates[0] as DriftInventory;
    chain.push(next);
    cursor = next.to;
  }
  return chain;
}

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value;
}

function sha(value: unknown, label: string): string {
  const result = string(value, label);
  if (!FULL_SHA.test(result)) fail(`${label} must be a full Git SHA`);
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) fail(`${label} must be a string array`);
  return value as string[];
}
