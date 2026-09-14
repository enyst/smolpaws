import { describe, expect, it } from 'vitest';

import {
  intervalChain,
  inventoryHash,
  parseInventory,
  parseServerReview,
  serverUnitKeys,
  validateServerReview,
  type DriftInventory,
  type ServerReviewRecord,
} from '../../scripts/server-review.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const S1 = '1'.repeat(40);
const S2 = '2'.repeat(40);
const K1 = '3'.repeat(40);

const rawInventory = {
  schemaVersion: 1,
  repository: 'OpenHands/software-agent-sdk',
  from: A,
  to: B,
  commits: [
    { sha: S1, subject: 'feat(agent-server): new route', units: { server: {} }, ignoredPaths: [] },
    { sha: K1, subject: 'fix(sdk): sdk only', units: { sdk: {} } },
    { sha: S2, subject: 'chore: release', units: { sdk: {}, server: {} } },
  ],
};
const inventory: DriftInventory = parseInventory(rawInventory, 'inventory');

const policies = [
  { id: 'DEV-SERVER-001', kind: 'DEVIATION', target: 'server' },
  { id: 'DEV-SDK-001', kind: 'DEVIATION', target: 'sdk' },
  { id: 'EXC-SDK-001', kind: 'EXCLUDED', target: 'sdk' },
];

function record(items: ServerReviewRecord['items'], overrides: Partial<ServerReviewRecord> = {}): ServerReviewRecord {
  return {
    schemaVersion: 1,
    repository: inventory.repository,
    from: inventory.from,
    to: inventory.to,
    inventorySha256: inventoryHash(rawInventory),
    items,
    ...overrides,
  };
}

const context = { policies, evidenceExists: (path: string) => path === 'src/__tests__/exists.test.ts' };

describe('server review records', () => {
  it('lists exactly the server units of an inventory', () => {
    expect(serverUnitKeys(inventory)).toEqual([`${S1}:server`, `${S2}:server`]);
  });

  it('accepts a complete record', () => {
    const review = record({
      [`${S1}:server`]: { disposition: 'PORT', policy: null, reason: 'ported the route', tracking: [], evidence: ['src/__tests__/exists.test.ts'] },
      [`${S2}:server`]: { disposition: 'NO_TARGET_CHANGE', policy: null, reason: 'version bump only', tracking: [], evidence: [] },
    });
    expect(validateServerReview(review, inventory, context)).toEqual([]);
  });

  it('reports missing, stale, and malformed items', () => {
    const review = record(
      {
        [`${S1}:server`]: { disposition: 'PORT', policy: null, reason: 'ported', tracking: [], evidence: [] },
        [`${K1}:server`]: { disposition: 'NO_TARGET_CHANGE', policy: null, reason: 'not a server unit', tracking: [], evidence: [] },
      },
      { inventorySha256: 'f'.repeat(64) },
    );
    const errors = validateServerReview(review, inventory, context);
    expect(errors).toContain(`aaaaaaaa..bbbbbbbb: missing review item ${S2}:server`);
    expect(errors).toContain(`aaaaaaaa..bbbbbbbb: stale or unknown review item ${K1}:server`);
    expect(errors).toContain('aaaaaaaa..bbbbbbbb: review inventory hash is stale');
    expect(errors).toContain(`${S1}:server PORT work needs TypeScript test evidence`);
  });

  it('checks policies, tracking, and evidence per disposition', () => {
    const review = record({
      [`${S1}:server`]: { disposition: 'DEVIATION', policy: 'DEV-SDK-001', reason: 'wrong target policy', tracking: [], evidence: [] },
      [`${S2}:server`]: { disposition: 'DEFERRED', policy: null, reason: 'later', tracking: [], evidence: [] },
    });
    expect(validateServerReview(review, inventory, context)).toEqual([
      `${S1}:server policy DEV-SDK-001 belongs to sdk, not server`,
      `${S2}:server DEFERRED work needs a tracking item`,
    ]);
    const more = record({
      [`${S1}:server`]: { disposition: 'NO_TARGET_CHANGE', policy: 'DEV-SERVER-001', reason: 'has a policy it must not', tracking: [], evidence: [] },
      [`${S2}:server`]: { disposition: 'PORT', policy: null, reason: 'evidence missing on disk', tracking: [], evidence: ['src/__tests__/nope.test.ts'] },
    });
    expect(validateServerReview(more, inventory, context)).toEqual([
      `${S1}:server must not attach policy DEV-SERVER-001 to NO_TARGET_CHANGE`,
      `${S2}:server evidence src/__tests__/nope.test.ts does not exist`,
    ]);
  });

  it('rejects unknown dispositions when parsing', () => {
    expect(() =>
      parseServerReview(record({ [`${S1}:server`]: { disposition: 'MAYBE' as never, policy: null, reason: 'x', tracking: [], evidence: [] } }), 'r'),
    ).toThrow(/disposition has an invalid value/);
  });

  it('walks the interval chain from since to the vendored pin and refuses gaps or forks', () => {
    const ab: DriftInventory = { ...inventory };
    const bc: DriftInventory = { ...inventory, from: B, to: C, commits: [] };
    expect(intervalChain(A, C, [bc, ab]).map((i) => i.to)).toEqual([B, C]);
    expect(intervalChain(C, C, [ab, bc])).toEqual([]);
    expect(() => intervalChain(A, C, [ab])).toThrow(/no vendored inventory continues from bbbbbbbb/);
    const fork: DriftInventory = { ...inventory, from: A, to: C, commits: [] };
    expect(() => intervalChain(A, C, [ab, fork, bc])).toThrow(/fork at aaaaaaaa/);
    // The same interval vendored twice under two file names is not a fork.
    expect(intervalChain(A, B, [ab, { ...ab }]).map((i) => i.to)).toEqual([B]);
  });
});
