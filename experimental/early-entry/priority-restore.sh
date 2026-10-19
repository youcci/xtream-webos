#!/bin/sh
set -eu
P=/var/lib/xtream-native
umask 077
exec >> "$P/early-entry/priority-restore.log" 2>&1
restore() {
    : > /run/xtream-native/priority-restored
    for name in xtream-native xtream-native-provider; do
        tasks="/sys/fs/cgroup/systemd/system.slice/$name.service/tasks"
        if [ -r "$tasks" ]; then
            while read -r pid; do
                case "$pid" in ''|*[!0-9]*) continue ;; esac
                [ "$pid" -gt 1 ] && renice -n 0 -p "$pid" || true
            done < "$tasks"
        fi
    done
    printf 'restored '; cat /proc/uptime
}
trap restore EXIT
trap 'exit 0' TERM INT
# Never reload PID1 here: this firmware can restart its web-app engine when
# lsm-ready.path is re-armed. Source unit files have no persistent Nice setting.
sleep 35
