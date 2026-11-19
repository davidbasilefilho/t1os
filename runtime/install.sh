#!/usr/bin/env bash
exec "$(dirname -- "$(realpath -e -- "$0")")/../bin/t1os-guest-platform" install-runtime "$@"
