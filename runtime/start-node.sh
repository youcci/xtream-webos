#!/bin/sh
set -eu
# An experimental early dispatcher may request a short CPU-priority lease.
# Normal Homebrew starts and later service restarts use ordinary priority.
if [ -f /run/xtream-native/early-start ] && [ ! -f /run/xtream-native/priority-restored ]; then
    exec /bin/nice -n -10 /usr/bin/node "$@"
fi
exec /usr/bin/node "$@"
