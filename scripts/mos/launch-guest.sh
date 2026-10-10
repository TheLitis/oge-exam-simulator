#!/bin/bash
# Start the installed app as the logged-in test user, with that user's GUI session.
set -euo pipefail
test "$(id -u)" = 0
test -f /etc/mos-testbed
plasma_pid=$(pgrep -u mosqa -x plasmashell | head -n 1)
test -n "$plasma_pid"
session_env=()
while IFS= read -r -d '' entry; do
  case "$entry" in
    DISPLAY=*|XAUTHORITY=*|DBUS_SESSION_BUS_ADDRESS=*|XDG_RUNTIME_DIR=*|XDG_SESSION_TYPE=*) session_env+=("$entry");;
  esac
done < "/proc/$plasma_pid/environ"
runuser -u mosqa -- env HOME=/home/mosqa "${session_env[@]}" bash -c 'nohup /home/mosqa/Applications/oge-exam-simulator-linux-x64/start.sh > /home/mosqa/test-evidence/app-launch.log 2>&1 < /dev/null &'
printf 'Simulator launch requested as mosqa in the existing Plasma session.\n'
