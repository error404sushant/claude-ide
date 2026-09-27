#!/bin/sh
# Applies Claude IDE patches onto a Code - OSS checkout (see scripts/apply-fork.mjs, which works on every platform).
exec node "$(cd "$(dirname "$0")" && pwd)/scripts/apply-fork.mjs" "$@"
