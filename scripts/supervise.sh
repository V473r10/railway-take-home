#!/usr/bin/env bash
# Run the app and start it again whenever it dies, the way Railway's ON_FAILURE
# restart policy does in production. Chaos mode's kill switch needs this locally.
# A clean exit (Ctrl-C) ends the loop.
set -uo pipefail
cd "$(dirname "$0")/.."
until node src/server/main.ts; do
  echo "supervise: the app exited with $?; starting it again in 1 s" >&2
  sleep 1
done
