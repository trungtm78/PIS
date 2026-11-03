#!/usr/bin/env bash
# STATUS: NOT RUN. Written on a host with no device; nobody has run this script on a phone.
#
# Cold start samples on one Android device for AC-ST-MOB-040-2 / UAT-NFR-PERFORMANCE-02.
#
#   ./run_cold_start_samples.sh <device-label> [runs] [adb serial]
#   ./run_cold_start_samples.sh pixel-8a-android14 25 > results/pixel-8a-android14/cold_start.csv
#   dart run tool/device/perf_verdict.dart results/pixel-8a-android14/cold_start.csv
#
# For each run the application is force-stopped (a cold start: no process), started, and the screen is read with uiautomator until
# the content of the loaded home screen is on it: the card "Hai tỷ lệ giải ngân", which is drawn only when the dashboard has its
# answer (the tab label "Trang chủ" is on screen before that and would time the shell, not the main content). The time is
# measured on this computer from the moment `am start` is issued to the moment the dump that contains the card was TAKEN, so the
# sample includes the cost of one hierarchy dump (about 0.3 to 1 s on a phone): the figure is an UPPER bound on "cold start to the
# main content". A failure caused by that overhead must be re-measured with a screen recording (docs/mobile-device-matrix.md,
# "Performance run"); a pass is a real pass.
#
# Preconditions: the build is installed, signed in to a seeded tenant, the same network as the matrix document says, the phone
# charged and cool (let it rest 2 minutes between devices), no other app in the foreground. Prints CSV lines on stdout only.
set -euo pipefail

label="${1:?usage: $0 <device-label> [runs] [adb serial]}"
runs="${2:-25}"
serial="${3:-}"
package="vn.machvon.app"
# the activity is written with its package: the applicationId (above) and the namespace of the build (where MainActivity lives) differ
activity="vn.machvon.machvon_mobile.MainActivity"
# the first card of the loaded home dashboard (mob.home.rates.title): on no loading, empty or failed screen; a test keeps it equal to the string table
marker="Hai tỷ lệ giải ngân"
adb_cmd=(adb)
[ -n "$serial" ] && adb_cmd=(adb -s "$serial")

now_ms() { python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || node -e 'console.log(Date.now())'; }

echo "metric,device,run,ms"
for run in $(seq 1 "$runs"); do
  "${adb_cmd[@]}" shell am force-stop "$package"
  sleep 3
  start=$(now_ms)
  "${adb_cmd[@]}" shell am start -n "$package/$activity" >/dev/null
  deadline=$((start + 15000))
  while :; do
    "${adb_cmd[@]}" shell uiautomator dump /sdcard/machvon_cold.xml >/dev/null 2>&1 || true
    taken=$(now_ms)
    if "${adb_cmd[@]}" shell cat /sdcard/machvon_cold.xml 2>/dev/null | grep -q "$marker"; then
      echo "cold_start_main_content_ms,$label,$run,$((taken - start))"
      break
    fi
    if [ "$taken" -gt "$deadline" ]; then
      # a start whose home content never shows within 15 s (still loading, or the dashboard failed) is a failed sample: it is written as 15000 so that it counts against the budget
      echo "cold_start_main_content_ms,$label,$run,15000"
      break
    fi
  done
done
