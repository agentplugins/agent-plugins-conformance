#!/bin/sh
exec node "$(dirname "$0")/../../dist/command-token-probe.mjs" posix-exact intact "$@"
