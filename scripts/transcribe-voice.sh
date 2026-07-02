#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <voice.ogg|wav> [lang] [model]" >&2
  exit 2
fi

INPUT="$1"
LANG="${2:-ru}"
VOICE_MODEL="${3:-tiny}"
WHISPER_DIR="${WHISPER_DIR:-$HOME/work/whisper.cpp}"
MODEL="${WHISPER_MODEL:-$WHISPER_DIR/models/ggml-${VOICE_MODEL}.bin}"
BIN="${WHISPER_BIN:-$WHISPER_DIR/build/bin/whisper-cli}"
TMP_DIR="${TMPDIR:-/tmp}"
BASE="$(basename "$INPUT")"
WAV="$TMP_DIR/${BASE%.*}.wav"
THREADS="${WHISPER_THREADS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 4)}"
BEAM_SIZE="${WHISPER_BEAM_SIZE:-1}"
BEST_OF="${WHISPER_BEST_OF:-1}"

if [[ ! -f "$BIN" ]]; then
  echo "whisper binary not found: $BIN" >&2
  exit 1
fi
if [[ ! -f "$MODEL" ]]; then
  echo "model not found: $MODEL" >&2
  exit 1
fi

if [[ "${INPUT##*.}" != "wav" ]]; then
  ffmpeg -y -i "$INPUT" -ar 16000 -ac 1 -c:a pcm_s16le "$WAV" >/dev/null 2>&1
else
  cp "$INPUT" "$WAV"
fi

ARGS=("-m" "$MODEL" "-f" "$WAV" "-t" "$THREADS" "-bs" "$BEAM_SIZE" "-bo" "$BEST_OF" "-nt" "-np")
if [[ "$LANG" != "auto" ]]; then
  ARGS+=("-l" "$LANG")
fi

"$BIN" "${ARGS[@]}"
