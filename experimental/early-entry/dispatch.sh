#!/bin/sh
set -eu
P=/var/lib/xtream-native
umask 077
exec >> "$P/early-entry/dispatch.log" 2>&1
printf 'dispatch-start '; cat /proc/uptime
case "${1:-probe}" in
start)
    [ -f "$P/enabled" ] || exit 0
    [ ! -e /var/luna/preferences/webosbrew_failsafe ] || exit 0
    systemd-run --unit=xtream-early-priority-restore --service-type=oneshot --no-block --property=UMask=0077 --property=TimeoutStartSec=80 /bin/sh "$P/early-entry/priority-restore.sh"
    if [ -e /tmp/lsm-ready ] && systemctl is-active --quiet surface-manager.service; then
        printf 'wam-start-request '; cat /proc/uptime
        systemctl start --no-block webapp-mgr.service
    fi
    mkdir -p /run/xtream-native
    chmod 700 /run/xtream-native
    : > /run/xtream-native/early-start
    mkdir -p /run/systemd/system
    for name in xtream-native-boot xtream-native-provider xtream-native; do
        cp "$P/$name.service" "/run/systemd/system/$name.service"
    done
    if ! systemctl start --no-block xtream-native-boot.service; then
        systemctl daemon-reload
        systemctl start --no-block xtream-native-boot.service
    fi
    printf 'dispatch-queued '; cat /proc/uptime
    exit 0
    ;;
probe) ;;
*) exit 2 ;;
esac
iteration=0
while [ "$iteration" -lt 30 ]; do
    printf '\nprobe '; cat /proc/uptime
    luna-send -w 500 -n 1 luna://com.webos.applicationManager/getForegroundAppInfo '{}' < /dev/zero || true
    luna-send -w 500 -n 1 luna://com.webos.applicationManager/running '{}' < /dev/zero || true
    luna-send -w 500 -n 1 luna://com.webos.service.utp.broadcast/bind '{}' < /dev/zero || true
    iteration=$((iteration+1))
    sleep 2
done
printf 'dispatch-complete '; cat /proc/uptime
