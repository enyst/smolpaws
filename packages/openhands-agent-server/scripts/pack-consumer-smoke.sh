#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/oh-agent-server-pack.XXXXXX")"
consumer_dir="$(mktemp -d "${TMPDIR:-/tmp}/oh-agent-server-consumer.XXXXXX")"

cleanup() {
  rm -rf "$pack_dir" "$consumer_dir"
}
trap cleanup EXIT

cd "$package_root"
npm pack --dry-run --pack-destination "$pack_dir"
npm pack --pack-destination "$pack_dir"

tarball="$(find "$pack_dir" -maxdepth 1 -name 'smolpaws-openhands-agent-server-*.tgz' -print -quit)"
if [ -z "$tarball" ]; then
  echo "Packed tarball not found" >&2
  exit 1
fi

cd "$consumer_dir"
npm init -y >/dev/null
npm install --ignore-scripts --no-audit "$tarball" typescript @types/node
cat > package.json <<JSON
{"type":"module","scripts":{"typecheck":"tsc --noEmit","smoke":"node smoke.mjs"},"dependencies":{"@smolpaws/openhands-agent-server":"file:$tarball","@types/node":"^22.18.6","typescript":"^5.9.2"},"devDependencies":{}}
JSON
cat > tsconfig.json <<'JSON'
{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"skipLibCheck":true}}
JSON
cat > index.ts <<'TS'
import { createAgentServerApp, generateOpenApiSchema, ConversationLease, conversationSecretRef } from "@smolpaws/openhands-agent-server";

const server = await createAgentServerApp({ config: { sessionApiKey: "consumer-smoke" } });
const schema = generateOpenApiSchema();
const leaseCtor: typeof ConversationLease = ConversationLease;
const ref = conversationSecretRef("00000000-0000-4000-8000-000000000000", "TOKEN");
await server.app.close();
console.log(schema.openapi, leaseCtor.name, ref.service);
TS
cat > smoke.mjs <<'JS'
import { createAgentServerApp, generateOpenApiSchema } from "@smolpaws/openhands-agent-server";

const server = await createAgentServerApp({ config: { sessionApiKey: "consumer-smoke" } });
const schema = generateOpenApiSchema();
console.log(schema.openapi, Boolean(schema.paths["/api/conversations/{conversation_id}/run"]));
await server.app.close();
JS
npm run typecheck
npm run smoke
