#!/usr/bin/env bash
# STATUS: NOT RUN. Written on a host with no device; nobody has run this script on a phone.
#
# The touch-area and name audit of AC-ST-MOB-040-1 / UAT-NFR-ACCESSIBILITY-02 on one Android device, at the system font scale 2.0.
#
#   ./android_a11y_audit.sh <device-label> <screens-file> [adb serial]
#
# <screens-file> has one screen per line: `MOB-47 Cá nhân` (the screen id, then any words that remind the tester how to reach it).
# For each screen the script asks the tester to open it on the phone and press Enter; it dumps the hierarchy and audits it with
# tool/device/touch_target_audit.dart (48 dp, and a name for every control). The dumps are kept in results/<device-label>/.
# At the end the system font scale is put back. A control that is smaller than 48 dp or has no name is printed with its bounds.
#
# This audits what the device DRAWS. It does not replace the run with TalkBack on (names and roles as spoken, the reading order,
# focus after a dialog), which only a person can do: see the checklist in docs/mobile-device-matrix.md.
set -euo pipefail

label="${1:?usage: $0 <device-label> <screens-file> [adb serial]}"
screens="${2:?usage: $0 <device-label> <screens-file> [adb serial]}"
serial="${3:-}"
adb_cmd=(adb)
[ -n "$serial" ] && adb_cmd=(adb -s "$serial")
out="results/$label"
mkdir -p "$out"

density=$("${adb_cmd[@]}" shell wm density | grep -o '[0-9]*$' | tail -1)
previous=$("${adb_cmd[@]}" shell settings get system font_scale | tr -d '\r')
restore() { "${adb_cmd[@]}" shell settings put system font_scale "${previous/null/1.0}"; }
trap restore EXIT

"${adb_cmd[@]}" shell settings put system font_scale 2.0
echo "density $density dpi, font scale 2.0 (was $previous)"

failed=0
dumps=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id="${line%% *}"
  read -r -p "Open $line on the phone, then press Enter " _ </dev/tty
  "${adb_cmd[@]}" shell uiautomator dump "/sdcard/machvon_$id.xml" >/dev/null
  "${adb_cmd[@]}" pull "/sdcard/machvon_$id.xml" "$out/$id.xml" >/dev/null
  dumps+=("$out/$id.xml")
done <"$screens"

dart run tool/device/touch_target_audit.dart "${dumps[0]}" "$density" "${dumps[@]:1}" || failed=1
exit "$failed"
