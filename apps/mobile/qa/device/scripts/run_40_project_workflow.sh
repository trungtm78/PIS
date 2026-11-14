#!/usr/bin/env bash
# STATUS: NOT RUN on any phone of the matrix. Run on the emulator "guide" only (Android 15, debug builds of both editions, lane fix9, 2026-11-14); see the header of flows/40_project_workflow.yaml for the result.
#
# Device evidence of AC-ST-MOB-040-1 for the workflow flow (TC-UAT-PWF-15, TC-UAT-PWF-OFF-01).
#
# Runs flows/40_project_workflow.yaml on an EMULATOR (or any rooted device that reaches the API through `adb reverse`) with a real "no connection" in its offline half.
#
#   adb root                                   (once, BEFORE the tunnels and the sign-in: it restarts adbd and drops every adb reverse)
#   adb reverse tcp:<api-port> tcp:<api-port>  (and the tunnel of the identity provider), then sign in (06_sign_in_test_idp.yaml)
#   ./run_40_project_workflow.sh <device-label> <api-port> [adb serial]
#
# Why a script: a debug build reaches a stack on this machine at http://127.0.0.1:<api-port> through `adb reverse` (plain http is allowed for a loopback host only; Android
# blocks it for every other host, 10.0.2.2 included: usesCleartextTraffic=false). Airplane mode switches the radios off but leaves the loopback and the adb tunnel up, and the
# emulator keeps its virtual interface, so the application still reaches the API: the command of the flow is sent at once and the line "sẽ gửi khi có mạng" never shows.
# Taking the tunnel away (`adb reverse --remove`) is not enough either: the connection the application keeps open to the API lives on, so it stays online for as long as it
# keeps asking (measured: no banner for 16 s, then at once on the next try). So the device itself refuses the traffic to the API port for as long as the flow is offline
# (iptables, which needs root: the emulator images without Google Play have it). Measured twice in a row: "Bạn đang ngoại tuyến" within 3 s of the rule, gone within 3 s without it.
# The flow says where it is with its screenshots (Maestro 2 writes them under --test-output-dir, here results/<device-label>/maestro; an older Maestro writes them into the
# folder it runs in, results/<device-label>: both are looked at):
#   40_task_ready.png   the task can be completed, the flow is about to go offline   -> the API port is refused
#   40_task_queued.png  the command waits in the queue of the phone                   -> the API port is open again, then the flow switches the radio on
# On a phone that reaches the API over its own network none of this is needed: run the flow with `maestro test` as its header says.
set -uo pipefail

label="${1:?usage: $0 <device-label> <api-port> [adb serial]}"
port="${2:?usage: $0 <device-label> <api-port> [adb serial]}"
serial="${3:-}"
# The paths and the rule below are arguments for the device, not paths of this machine (Git Bash would rewrite them).
export MSYS_NO_PATHCONV=1
adb_cmd=(adb)
maestro_cmd=(maestro)
if [ -n "$serial" ]; then
  adb_cmd=(adb -s "$serial")
  maestro_cmd=(maestro --device "$serial")
fi
here="$(cd "$(dirname "$0")" && pwd)"
flow="$here/../flows/40_project_workflow.yaml"
out="$here/../results/$label"
mkdir -p "$out"
cd "$out"
rm -rf maestro 40_task_ready.png 40_task_queued.png 40_done
command -v cygpath >/dev/null 2>&1 && flow="$(cygpath -w "$flow")"

if [ "$("${adb_cmd[@]}" shell id -u | tr -d '\r')" != "0" ]; then
  echo "the device is not rooted (run 'adb root' before the tunnels and the sign-in): the API cannot be cut, the offline half of the flow would prove nothing" >&2
  exit 2
fi
rule="-p tcp -d 127.0.0.1 --dport $port -j REJECT --reject-with tcp-reset"
block() { "${adb_cmd[@]}" shell "iptables -I OUTPUT $rule"; }
# Every copy of the rule goes (an earlier run that was killed may have left one).
unblock() { while "${adb_cmd[@]}" shell "iptables -D OUTPUT $rule" >/dev/null 2>&1; do :; done; }
mark() { [ -n "$(find . -name "$1" -print -quit 2>/dev/null)" ]; }

unblock
: > 40_offline.log

# The watcher: one pass over the two marks. It ends when the flow does (the file `40_done`).
(
  cut=0
  while [ ! -e 40_done ]; do
    if [ "$cut" = 0 ] && mark 40_task_ready.png; then
      block
      cut=1
      echo "API port refused $(date +%H:%M:%S)" >> 40_offline.log
    fi
    if [ "$cut" = 1 ] && mark 40_task_queued.png; then
      unblock
      cut=2
      echo "API port open again $(date +%H:%M:%S)" >> 40_offline.log
    fi
    sleep 0.3
  done
) &
watcher=$!

"${maestro_cmd[@]}" test --format junit --output 40_workflow.xml --test-output-dir maestro "$flow"
code=$?

touch 40_done
wait "$watcher" 2>/dev/null
rm -f 40_done
# Whatever happened, the device is left online.
unblock
"${adb_cmd[@]}" shell cmd connectivity airplane-mode disable >/dev/null 2>&1
cat 40_offline.log
exit "$code"
