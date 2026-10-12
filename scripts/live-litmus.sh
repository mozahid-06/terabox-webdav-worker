#!/usr/bin/env bash
# Full litmus conformance suite against the deployed worker (138 tests).
# STANDING RULE: run this ONCE per free-tier quota window (00:00 UTC) —
# litmus is DO-write heavy (locks/props/upload state) and a single full run
# has burned the Workers free tier rows-written quota inside a minute, which
# 500s EVERY request on the account until the reset. Smoke first (cheap),
# litmus only when smoke is green and quota headroom is known.
#
#   BASE=https://davbox.crazy-gooner-mf.workers.dev/dav USER_CRED=taxin:404 \
#     ./scripts/live-litmus.sh
#
# Suites must run against the litmus COLLECTION under the WebDAV root
# (/dav/litmus/ — a root-level /litmus/ 404s; each suite MKCOLs its own
# /dav/litmus/litmus/ work collection and needs the parent to exist).
set -u
B="${BASE:-https://davbox.crazy-gooner-mf.workers.dev/dav}"
A="${USER_CRED:-taxin:404}"
U="${A%%:*}"
P="${A#*:}"
LITMUS_SRC="${LITMUS_SRC:-/tmp/opencode/litmus}"
SUITES="${SUITES:-basic copymove locks http props protected lockbomb}"

[ -x "$LITMUS_SRC/basic" ] || { echo "litmus binaries not built at $LITMUS_SRC"; exit 2; }

# Cheap pre-flight: if the quota is already exhausted, do not add DO writes.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -X PROPFIND -H 'Depth: 0' -u "$A" "$B/litmus/" || echo 000)
case "$code" in
  207|404) ;; # 404 = parent missing (still worth showing), 207 = healthy
  *) echo "pre-flight: worker answering $code — quota likely exhausted, aborting"; exit 3 ;;
esac

rc=0
for t in $SUITES; do
  echo "===== $t ====="
  (cd "$LITMUS_SRC" && "./$t" "$B/litmus/" "$U" "$P") || rc=1
done
exit $rc
