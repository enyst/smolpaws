#!/usr/bin/env bash
#
# Remove the LaunchAgent for one standalone SmolPaws bridge.
#
#   scripts/remove-bridge-launchagent.sh <bridge>

set -euo pipefail

BRIDGE="${1:-}"
if [[ -z "$BRIDGE" ]]; then
  echo "usage: $0 <bridge>" >&2
  exit 2
fi

LABEL="com.smolpaws.bridge.${BRIDGE}"
TARGET_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)" "${TARGET_PLIST}" >/dev/null 2>&1 || true
rm -f "${TARGET_PLIST}"

echo "Removed SmolPaws bridge LaunchAgent ${LABEL}."
