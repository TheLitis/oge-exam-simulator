#!/bin/bash
# Run through guest.cjs as root in the installed, disposable MOS VM.
set -euo pipefail
test "$(id -u)" = 0
test -f /etc/mos-testbed
test "$(. /etc/os-release; printf '%s' "$ID")" = mos
test -b /dev/vda
test "$(findmnt -n -o SOURCE /)" != /dev/mapper/live-rw
id mosqa >/dev/null
guest_home=/home/mosqa
app_archive=/var/tmp/oge-exam-simulator-linux-x64.tar.gz
source_archive=/var/tmp/oge-exam-source.zip
curl --fail --silent --show-error http://10.0.2.2:13601/oge-exam-simulator-linux-x64.tar.gz -o "$app_archive"
printf '%s  %s\n' d8443c957da6facdb3727ff481d466ea5dcf3dedaefe21b49110520bea787f99 "$app_archive" | sha256sum --check --status
curl --fail --silent --show-error http://10.0.2.2:13601/oge-exam-source.zip -o "$source_archive"
printf '%s  %s\n' a7ad35a7bc6105f470557525a995c36dde2bcd33c3a5318f7b9de2307c9f11b0 "$source_archive" | sha256sum --check --status
install -d -o mosqa -g mosqa "$guest_home/Applications" "$guest_home/Sim-source" "$guest_home/test-evidence"
tar -xzf "$app_archive" -C "$guest_home/Applications"
python3 - "$source_archive" "$guest_home/Sim-source" <<'PY'
import pathlib, sys, zipfile
dest = pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as archive:
    for item in archive.infolist():
        target = (dest / item.filename).resolve()
        if target != dest and dest not in target.parents:
            raise RuntimeError('Invalid source archive path')
    archive.extractall(dest)
PY
chown -R mosqa:mosqa "$guest_home/Applications" "$guest_home/Sim-source" "$guest_home/test-evidence"
app_dir="$guest_home/Applications/oge-exam-simulator-linux-x64"
source_dir="$guest_home/Sim-source/oge-exam-simulator"
runuser -u mosqa -- bash -c 'cd "$1"; sha256sum --check SHA256SUMS.txt > "$2"' bash "$app_dir" "$guest_home/test-evidence/bundle-checksums.log"
runuser -u mosqa -- "$app_dir/runtime/node" --version
runuser -u mosqa -- env HOME="$guest_home" "$app_dir/install-menu.sh"
desktop_dir=$(runuser -u mosqa -- env HOME="$guest_home" xdg-user-dir DESKTOP)
test -n "$desktop_dir"
case "$desktop_dir" in "$guest_home"/*) ;; *) echo 'Unexpected desktop directory' >&2; exit 1;; esac
install -d -o mosqa -g mosqa "$desktop_dir"
install -o mosqa -g mosqa -m 0755 "$guest_home/.local/share/applications/oge-exam-simulator.desktop" "$desktop_dir/oge-exam-simulator.desktop"
runuser -u mosqa -- bash -c 'cd "$1"; "$2" scripts/check.cjs > "$3" 2>&1' bash "$source_dir" "$app_dir/runtime/node" "$guest_home/test-evidence/syntax-check.log"
runuser -u mosqa -- bash -c 'cd "$1"; "$2" --test test/*.test.cjs > "$3" 2>&1' bash "$source_dir" "$app_dir/runtime/node" "$guest_home/test-evidence/node-tests.tap"
cat /etc/os-release > "$guest_home/test-evidence/os-release.txt"
uname -a > "$guest_home/test-evidence/kernel.txt"
rpm -q glibc chromium-browser-stable plasma5-workspace qemu-guest-agent > "$guest_home/test-evidence/package-versions.txt"
chown mosqa:mosqa "$guest_home/test-evidence/"*
printf 'Bundle checksums: %s files verified\n' "$(wc -l < "$guest_home/test-evidence/bundle-checksums.log")"
cat "$guest_home/test-evidence/syntax-check.log"
tail -n 12 "$guest_home/test-evidence/node-tests.tap"
