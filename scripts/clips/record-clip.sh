#!/usr/bin/env bash
# One clip, end to end, on a running seeded stack (see docs/clip-data.md for the stack window):
#   scripts/clips/record-clip.sh <public-investment|enterprise-phu-my> <main|chapter-id> <out-dir> [make.mjs flags]
# Needs: E2E_SESSION_KEY and E2E_STACK_INFO of the stack, the API on 127.0.0.1:47311 and the web app (vite with the development users) on 127.0.0.1:47313.
# The voice is the fallback voice (edge-tts) until VIENEU_TTS_API_KEY is set; then use tts.mjs (VieNeuTTS) in place of tts-edge.mjs in the second step.
# Music: the proposed track of production/music.json is used when its file exists (mix.mjs --no-music turns it off). Nothing here reads or writes a key.
set -euo pipefail
CLIP="$1"; CUT="$2"; OUT="$3"; shift 3
API="${CLIPS_API_URL:-http://127.0.0.1:47311}"
WEB="${CLIPS_WEB_URL:-http://127.0.0.1:47313}"
mkdir -p "$OUT"
node scripts/clips/manifest.mjs "$CLIP" --api "$API" ${APPLY_LOG:+--apply-log "$APPLY_LOG"} --out "$OUT/$CLIP.manifest.json"
node scripts/clips/tts-edge.mjs "$CLIP" "$CUT" --manifest "$OUT/$CLIP.manifest.json" --out "$OUT/$CLIP.$CUT.audio.json" --limit 3
node scripts/clips/make.mjs "$CLIP" "$CUT" --audio "$OUT/$CLIP.$CUT.audio.json" --manifest "$OUT/$CLIP.manifest.json" --web-url "$WEB" --out "$OUT/work" "$@"
BAR="$OUT/work/$CLIP.$CUT.bar.txt"; [ -f "$BAR" ] || BAR=""
CLIPS_X264_PRESET="${CLIPS_X264_PRESET:-veryfast}" node scripts/clips/mix.mjs --clip "$CLIP" --video "$OUT/work/$CLIP.$CUT.screen.mp4" ${BAR:+--bar "$BAR"} --timeline "$OUT/work/$CLIP.$CUT.timeline.json" --audio "$OUT/$CLIP.$CUT.audio.json" --out "$OUT/$CLIP.$CUT.mp4"
node scripts/clips/verify.mjs "$OUT/$CLIP.$CUT.mp4" --kind "$([ "$CUT" = main ] && echo main || echo chapter)"
