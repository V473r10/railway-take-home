#!/usr/bin/env bash
# A throwaway Postgres cluster for the test suite, for machines without Docker
# or a usable system role. Lives under .scratch/ (gitignored), listens on
# 127.0.0.1 only, trust auth, superuser "postgres".
#
#   scripts/test-db.sh         start (initialising on first run)
#   scripts/test-db.sh stop    stop it
#
# Tests read TEST_DATABASE_URL and default to this cluster's URL.
set -euo pipefail

cd "$(dirname "$0")/.."
DATA=.scratch/pg-test
PORT="${TEST_PG_PORT:-54329}"
LOG=.scratch/pg-test.log

if [[ "${1:-start}" == "stop" ]]; then
  pg_ctl -D "$DATA" stop -m fast
  exit 0
fi

if [[ ! -f "$DATA/PG_VERSION" ]]; then
  mkdir -p .scratch
  initdb -D "$DATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
fi

if ! pg_ctl -D "$DATA" status >/dev/null 2>&1; then
  pg_ctl -D "$DATA" -l "$LOG" -w \
    -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
    start >/dev/null
fi

echo "TEST_DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/postgres"
