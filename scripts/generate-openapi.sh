#!/usr/bin/env bash

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

schema_path="$repo_root/packages/openhands-agent-server/openapi.json"

(
  cd "$repo_root/packages/openhands-agent-server"
  SCHEMA_PATH="$schema_path" npm run openapi
)
