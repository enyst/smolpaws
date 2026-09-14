/**
 * `npm run test:server-review`: every vendored SDK interval from `transpile/server-reviews.json#since`
 * up to the vendored pin has a complete, current server review record.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  intervalChain,
  intervalName,
  parseInventory,
  parseServerReview,
  validateServerReview,
  type ManifestPolicy,
} from './server-review.js';
import { loadUpstreamManifest, upstreamManifestPath, vendoredAgentRoot } from './upstream-manifest.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recordsDir = resolve(packageRoot, 'transpile/updates');
const configPath = resolve(packageRoot, 'transpile/server-reviews.json');
const inventoriesDir = resolve(vendoredAgentRoot, 'transpile/updates');

const manifest = loadUpstreamManifest();
const rawManifest = JSON.parse(readFileSync(upstreamManifestPath, 'utf8')) as { policies: ManifestPolicy[] };
const config = JSON.parse(readFileSync(configPath, 'utf8')) as { since?: unknown };
if (typeof config.since !== 'string' || !/^[0-9a-f]{40}$/.test(config.since)) {
  throw new Error(`${configPath} must name the full upstream SHA from which server review records are required`);
}

const inventories = existsSync(inventoriesDir)
  ? readdirSync(inventoriesDir)
      .filter((file) => file.endsWith('.inventory.json'))
      .map((file) => parseInventory(JSON.parse(readFileSync(resolve(inventoriesDir, file), 'utf8')), file))
  : [];

const chain = intervalChain(config.since, manifest.commit, inventories);
const failures: string[] = [];
for (const inventory of chain) {
  const name = intervalName(inventory.from, inventory.to);
  const jsonPath = resolve(recordsDir, `${name}.json`);
  const mdPath = resolve(recordsDir, `${name}.md`);
  if (!existsSync(jsonPath)) {
    failures.push(`${name}: missing server review record transpile/updates/${name}.json`);
    continue;
  }
  if (!existsSync(mdPath)) failures.push(`${name}: missing human-readable record transpile/updates/${name}.md`);
  const review = parseServerReview(JSON.parse(readFileSync(jsonPath, 'utf8')), `transpile/updates/${name}.json`);
  failures.push(
    ...validateServerReview(review, inventory, {
      policies: rawManifest.policies,
      evidenceExists: (path) => existsSync(resolve(packageRoot, path)),
    }),
  );
}

if (failures.length > 0) {
  console.error('Server review records are incomplete:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  chain.length === 0
    ? `Server review records: nothing to review since ${config.since.slice(0, 8)} (vendored pin ${manifest.commit.slice(0, 8)})`
    : `Server review records complete for ${chain.map((inventory) => intervalName(inventory.from, inventory.to)).join(', ')} (vendored pin ${manifest.commit.slice(0, 8)})`,
);
