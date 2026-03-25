#!/usr/bin/env bash
# Install Agent Mail as a LaunchAgent so it auto-starts on login.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOLPAWS_HOME_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
AGENT_MAIL_ROOT="${HOME}/repos/mcp_agent_mail"
TEMPLATE_PLIST="${ROOT_DIR}/launchd/com.agentmail.plist"
TARGET_PLIST="${LAUNCH_AGENTS_DIR}/com.agentmail.plist"
LOG_DIR="${SMOLPAWS_HOME_DIR}/logs"
PATH_VALUE="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin}"
UV_PATH="$(which uv 2>/dev/null || echo '/Users/enyst/.local/bin/uv')"

mkdir -p "${LAUNCH_AGENTS_DIR}" "${LOG_DIR}"

if [ ! -d "${AGENT_MAIL_ROOT}" ]; then
  echo "ERROR: Agent Mail repo not found at ${AGENT_MAIL_ROOT}"
  exit 1
fi

python3 - <<'PY' "${TEMPLATE_PLIST}" "${TARGET_PLIST}" "${AGENT_MAIL_ROOT}" "${HOME}" "${LOG_DIR}" "${PATH_VALUE}" "${UV_PATH}"
from pathlib import Path
import sys

template_path, target_path, agent_mail_root, home, log_dir, path_value, uv_path = sys.argv[1:]
content = Path(template_path).read_text()
for key, value in {
    '{{AGENT_MAIL_ROOT}}': agent_mail_root,
    '{{HOME}}': home,
    '{{LOG_DIR}}': log_dir,
    '{{PATH}}': path_value,
    '{{UV_PATH}}': uv_path,
}.items():
    content = content.replace(key, value)
Path(target_path).write_text(content)
PY

launchctl bootout "gui/$(id -u)" "${TARGET_PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${TARGET_PLIST}"
launchctl enable "gui/$(id -u)/com.agentmail"
launchctl kickstart -k "gui/$(id -u)/com.agentmail"

echo "Installed Agent Mail LaunchAgent:"
echo "  Plist: ${TARGET_PLIST}"
echo "  Logs:  ${LOG_DIR}/agentmail.launchagent.{log,error.log}"
echo "  Port:  127.0.0.1:8765"
