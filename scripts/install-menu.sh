#!/bin/sh
# Adds a launcher only to the CURRENT user's menu. No root privileges needed.
set -eu
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unset NODE_OPTIONS NODE_PATH
exec "$BASE/runtime/node" "$BASE/app/scripts/install-menu.cjs" "$BASE"
