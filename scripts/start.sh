#!/bin/sh
# Launch from any directory. All runtime dependencies specific to Node are bundled.
set -eu
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  printf '%s\n' 'Эта сборка предназначена для Linux x86_64 (MOS ОС), а не Windows или macOS.' >&2
  exit 1
fi
unset NODE_OPTIONS NODE_PATH
exec "$BASE/runtime/node" "$BASE/app/src/server.cjs" "$@"
