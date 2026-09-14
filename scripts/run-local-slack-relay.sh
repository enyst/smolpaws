#!/usr/bin/env bash
#
# Compatibility wrapper. The generic launcher starts any standalone bridge and the
# agent-server it needs:
#
#   scripts/run-local-bridge.sh slack
#
# Unlike the earlier version of this script, the agent-server is left running when
# the bridge exits, because other bridges (WhatsApp, Discord) share it.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT_DIR/scripts/run-local-bridge.sh" slack "$@"
