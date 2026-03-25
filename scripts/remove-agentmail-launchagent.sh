#!/usr/bin/env bash
# Remove the Agent Mail LaunchAgent.

LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
TARGET_PLIST="${LAUNCH_AGENTS_DIR}/com.agentmail.plist"

if [ ! -f "${TARGET_PLIST}" ]; then
  echo "Agent Mail LaunchAgent not installed."
  exit 0
fi

launchctl bootout "gui/$(id -u)" "${TARGET_PLIST}" >/dev/null 2>&1 || true
rm -f "${TARGET_PLIST}"

echo "Removed Agent Mail LaunchAgent."
