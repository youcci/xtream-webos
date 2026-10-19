#!/bin/sh
set -eu
P=/var/lib/xtream-native
call() { luna-send -w 15000 -n 1 "$1" "$2" < /dev/zero; }
case "${1:-start}" in
start)
    node "$P/prepare.js" --check-schema
    sh "$P/hooks/55-disable-lg-channels"
    mkdir -p /tmp/epg /tmp/xtream-native /run/systemd/system
    chmod 700 /tmp/xtream-native
    if [ -f "$P/guide-cache.sqlite" ]; then
        count=$(sqlite3 /tmp/epg/PBS_EPG_DB.db "SELECT count(*) FROM PBS_BROADCAST_SCHEDULE WHERE substr(chan_code,1,7)='xtream_';" 2>/dev/null || echo 0)
        if [ "$count" = 0 ]; then
            cp "$P/guide-cache.sqlite" /tmp/epg/PBS_EPG_DB.db
            chmod 600 /tmp/epg/PBS_EPG_DB.db
        fi
    fi
    sqlite3 /tmp/epg/PBS_EPG_DB.db < "$P/guide-schema.sql"
    for name in xtream-native xtream-native-provider; do
        cp "$P/$name.service" "/run/systemd/system/$name.service"
    done
    # Bind the reviewable QML overlays; the firmware files stay intact.
    for relative in main.qml Pages/Page1/Components/SettingPopupFeed.qml Controllers/ChannelInterfaces/Interfaces.qml; do
        target="/usr/palm/applications/com.webos.app.livemenu/qml/$relative"
        grep -q " $target " /proc/mounts || mount --bind "$P/patches/$relative" "$target"
    done
    # LG restores a precompiled Guide process from CRIU. Invalidate only that
    # app's checkpoint when our QML or its firmware executable changes, so the
    # next Guide launch reads the mounted files and generates a fresh snapshot.
    ui_version=$(node -e 'var fs=require("fs"),hash=require("crypto").createHash("sha256");process.argv.slice(1).forEach(function(file){hash.update(fs.readFileSync(file));});process.stdout.write(hash.digest("hex"));' "$P/patches/main.qml" "$P/patches/Pages/Page1/Components/SettingPopupFeed.qml" "$P/patches/Controllers/ChannelInterfaces/Interfaces.qml" /usr/bin/com.webos.app.livemenu)
    if [ "$ui_version" != "$(cat "$P/native-ui-version" 2>/dev/null || true)" ]; then
        rm -f /tmp/checkpoint/com.webos.app.livemenu/pgid /mnt/lg/cmn_data/checkpoint/com.webos.app.livemenu/pgid /tmp/checkpoint/hash_check_com.webos.app.livemenu
        for guide_pid in $(pidof com.webos.app.livemenu || true); do
            kill -TERM "$guide_pid" 2>/dev/null || true
        done
        printf '%s\n' "$ui_version" > "$P/native-ui-version"
    fi
    systemctl daemon-reload
    systemctl start xtream-native-provider.service xtream-native.service
    attempt=0
    while [ "$attempt" -lt 10 ]; do
        if curl --max-time 1 -fs --unix-socket "$P/native.sock" -H 'Content-Type: application/json' -d '{"uri":"ping"}' http://localhost/ >/dev/null 2>&1; then break; fi
        attempt=$((attempt+1)); sleep 1
    done
    curl --max-time 2 -fs --unix-socket "$P/native.sock" -H 'Content-Type: application/json' -d '{"uri":"ping"}' http://localhost/ >/dev/null || { echo 'Native provider did not start.' >&2; exit 1; }
    attempt=0
    while [ "$attempt" -lt 15 ]; do
        if curl --max-time 1 -fs http://127.0.0.1:17651/status >/dev/null 2>&1; then break; fi
        attempt=$((attempt+1)); sleep 1
    done
    curl --max-time 2 -fs http://127.0.0.1:17651/status >/dev/null || { echo 'Management service did not start.' >&2; exit 1; }
    node "$P/lib/boot-player.js"
    ;;
stop)
    systemctl stop xtream-native-boot.service 2>/dev/null || true
    call luna://com.webos.service.wampluggable.dmost/setDmostUrl '{"url":"file:///usr/palm/applications/com.webos.app.livedmost/index.html"}' >/dev/null || true
    systemctl stop xtream-native.service xtream-native-provider.service || true
    ;;
restart)
    systemctl restart xtream-native-provider.service xtream-native.service
    ;;
*) echo 'Usage: control.sh start|stop|restart' >&2; exit 2 ;;
esac
