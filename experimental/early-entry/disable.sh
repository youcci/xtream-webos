#!/bin/sh
set -eu
P=/var/lib/xtream-native
env_file=/var/systemd/system/env/tts.env
umask 077
rm -f "$P/early-entry/auto-rearm" "$P/early-entry/armed"
mkdir -p /run/xtream-native
expected=/run/xtream-native/tts.env.expected
trap 'rm -f "$expected"' EXIT
cat > "$expected" <<'EOF'
LD_PRELOAD=/var/lib/xtream-native/early-entry/libxtream-early.so
XTREAM_EARLY_ENTRY=1
XTREAM_EARLY_DISPATCH=start
EOF
if [ -e "$env_file" ]; then
    if ! cmp -s "$env_file" "$expected"; then
        echo 'The TTS environment contains other configuration. Remove only the Xtream preload settings manually before deleting the library.' >&2
        exit 1
    fi
    rm "$env_file"
fi
# Stopping the priority lease invokes its restoration trap. Do not reload PID1.
systemctl stop xtream-early-priority-restore.service xtream-early-entry.service 2>/dev/null || true
echo 'Early entry disabled. Runtime files and normal Homebrew startup are retained.'
