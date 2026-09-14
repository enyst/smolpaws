#!/usr/bin/env bash
#
# Install (or reinstall) a LaunchAgent that keeps one standalone SmolPaws bridge running.
#
#   scripts/install-bridge-launchagent.sh <bridge>      # slack | whatsapp | discord
#
# The agent runs scripts/run-local-bridge.sh <bridge>, which starts the TypeScript
# agent-server on demand and then the bridge. KeepAlive restarts the bridge if it
# exits; the shared agent-server keeps running for the other bridges.
#
# Pair with scripts/remove-bridge-launchagent.sh <bridge>.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE="${1:-}"
if [[ -z "$BRIDGE" || ! -f "$ROOT_DIR/apps/$BRIDGE/plugin.json" ]]; then
  echo "usage: $0 <bridge> (a standalone app under apps/)" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "LaunchAgents are macOS only." >&2
  exit 1
fi

SMOLPAWS_HOME_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
LABEL="com.smolpaws.bridge.${BRIDGE}"
TARGET_PLIST="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
TEMPLATE_PLIST="${ROOT_DIR}/launchd/com.smolpaws.bridge.plist"
LOG_DIR="${SMOLPAWS_HOME_DIR}/logs"
PATH_VALUE="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin}"

mkdir -p "${LAUNCH_AGENTS_DIR}" "${LOG_DIR}"

python3 - <<'PY' "${TEMPLATE_PLIST}" "${TARGET_PLIST}" "${ROOT_DIR}" "${HOME}" "${SMOLPAWS_HOME_DIR}" "${LOG_DIR}" "${PATH_VALUE}" "${BRIDGE}"
from pathlib import Path
import sys

template_path, target_path, project_root, home, smolpaws_home, log_dir, path_value, bridge = sys.argv[1:]
content = Path(template_path).read_text()
for key, value in {
    '{{PROJECT_ROOT}}': project_root,
    '{{HOME}}': home,
    '{{SMOLPAWS_HOME_DIR}}': smolpaws_home,
    '{{LOG_DIR}}': log_dir,
    '{{PATH}}': path_value,
    '{{BRIDGE}}': bridge,
}.items():
    content = content.replace(key, value)
Path(target_path).write_text(content)
PY

launchctl bootout "gui/$(id -u)" "${TARGET_PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${TARGET_PLIST}"
launchctl enable "gui/$(id -u)/${LABEL}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "Installed SmolPaws bridge LaunchAgent ${LABEL}:"
echo "${TARGET_PLIST}"
echo "Logs: ${LOG_DIR}/bridge.${BRIDGE}.launchagent.log"
