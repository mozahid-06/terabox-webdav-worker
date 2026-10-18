#!/usr/bin/env bash
# chunk-upload.sh — push a local file through the worker's `.resumable`
# control plane (the same begin -> chunk PUTs -> finalize pipeline the web
# viewer uses). Bypasses Cloudflare's ~100 MB single-request edge cap, so
# files far past it go through where WebDAV clients (gvfs/rclone/davfs2)
# get their connection killed with "HTTP Error: (null)".
#
# Usage:
#   ./scripts/chunk-upload.sh <base> <user:pass> <local-file> [dest-dir]
#     <base>     worker dav base WITH trailing slash, e.g.
#                https://davbox.tes1ing.workers.dev/dav/
#     <dest-dir> mount-relative dav folder, must start and end with /
#                (default: / — the mount root)
#
# Behaviour: begin without If-None-Match -> an existing file is REPLACED
# (the server picks overwriteMode from the stat, mirroring PUT). Chunks
# retry on transient failures and are paced ~0.45 s apart to stay under the
# upstream ~1 req/400 ms throttle. Names with characters upstream refuses
# (emoji, : ? * " < > | \, controls) are rewritten to '#' server-side, same
# as every other write. A dead connection mid-run leaves an orphan session
# that expires on its own 24 h TTL; a rerun simply starts fresh.
set -euo pipefail

BASE="${1:?usage: chunk-upload.sh <base-with-trailing-slash> <user:pass> <local-file> [dest-dir=/]}"
CRED="${2:?missing user:pass}"
FILE="${3:?missing local file}"
DEST="${4:-/}"
case "$DEST" in
  / | /*/) ;;
  *) echo "dest-dir must start and end with / (got: $DEST)" >&2; exit 2 ;;
esac

[[ -f "$FILE" ]] || { echo "no such file: $FILE" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl missing" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq missing" >&2; exit 2; }
command -v dd >/dev/null || { echo "dd missing" >&2; exit 2; }

NAME=$(basename "$FILE")
SIZE=$(stat -c %s "$FILE")
MTIME_MS=$(( $(stat -c %Y "$FILE") * 1000 ))

PATHJSON=$(python3 - "$DEST$NAME" "$SIZE" "$MTIME_MS" <<'PY'
import json, sys
print(json.dumps({"path": sys.argv[1], "size": int(sys.argv[2]), "mtimeMs": int(sys.argv[3])}))
PY
)

api() { # method path [extra curl args...] — prints body on stdout, http code on stderr
  local m=$1 p=$2; shift 2
  curl -sS --max-time 120 -u "$CRED" -X "$m" "$BASE$p" "$@"
}

echo "file: $FILE ($SIZE bytes) -> $DEST$NAME" >&2

# ---- begin ----
if ! BEGIN=$(api POST .resumable -H 'Content-Type: application/json' --data "$PATHJSON"); then
  echo "begin request failed (network?)" >&2; exit 1
fi
if ! read -r ID CHUNK CHUNKS < <(printf '%s\n' "$BEGIN" | jq -r '[.uploadId, .chunkSize, .chunkCount] | @tsv'); then
  echo "begin unreadable: $BEGIN" >&2; exit 1
fi
if [[ -z "$ID" || "$ID" == "null" || -z "$CHUNK" || "$CHUNK" == "null" ]]; then
  echo "begin failed: $BEGIN" >&2; exit 1
fi
LAST=$(( CHUNKS - 1 ))
echo "session: chunkSize=$CHUNK chunkCount=$CHUNKS" >&2

# ---- chunks ----
for i in $(seq 0 "$LAST"); do
  [[ $i -eq $LAST ]] && CHUNK_HERE=$(( SIZE - CHUNK * LAST )) || CHUNK_HERE=$CHUNK
  attempt=0 code=000
  while :; do
    (( attempt >= 5 )) && {
      echo "chunk $((i+1))/$CHUNKS failed 5x (last HTTP $code) — cancelling session" >&2
      api DELETE ".resumable/$ID" >/dev/null 2>&1 || true
      exit 1
    }
    attempt=$(( attempt + 1 ))
    code=$(dd if="$FILE" bs="$CHUNK" skip="$i" count=1 iflag=fullblock status=none 2>/dev/null | \
           api PUT ".resumable/$ID/$i" -H 'Content-Type: application/octet-stream' \
               --data-binary @- -o /dev/null -w '%{http_code}') || code=000
    case "$code" in 2*) break ;; 4*) # auth/validator problems never heal by retrying
        echo "chunk $((i+1))/$CHUNKS: HTTP $code (not retryable) — cancelling session" >&2
        api DELETE ".resumable/$ID" >/dev/null 2>&1 || true
        exit 1 ;; esac
    echo "  chunk $((i+1))/$CHUNKS attempt $attempt failed (HTTP $code); backing off" >&2
    sleep $(( attempt * attempt )) || true
  done
  pct=$(( (i + 1) * 100 / CHUNKS ))
  printf 'chunk %d/%d  %d%%\n' "$((i+1))" "$CHUNKS" "$pct" >&2
  (( i < LAST )) && sleep 0.45 || true
done

# ---- finalize ----
FIN=$(api POST ".resumable/$ID/finalize" -o /dev/null -w '%{http_code}') || FIN=000
case "$FIN" in
  2*) echo "DONE: $DEST$NAME ($SIZE bytes, $CHUNKS chunks) [HTTP $FIN]" ;;
  *)  echo "finalize returned HTTP $FIN — the session survives; POST $BASE.resumable/$ID/finalize to retry" >&2; exit 1 ;;
esac
