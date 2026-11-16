#!/usr/bin/env bash
# Kept for the documented command; the drill itself is selftest.cjs (Node only, runs on Windows too).
exec node "$(dirname "$0")/selftest.cjs" "$@"
