# Troubleshooting

Start with read-only checks:

```sh
python3 tools/xtream_webos.py --host TV_IP --key ~/.ssh/webos_tv doctor
python3 tools/xtream_webos.py --host TV_IP --key ~/.ssh/webos_tv status
ssh -i ~/.ssh/webos_tv root@TV_IP 'systemctl is-active xtream-native.service xtream-native-provider.service; tail -n 40 /var/lib/xtream-native/boot.log'
```

Review logs before sharing them. Do not upload settings, library/catalogue JSON, native databases, launcher packages or root keys. `doctor` reporting an existing overlay is normal **after** installation; it prevents accidental fresh-install overwrite.

## I saved an account, but there are no channels

Save & sync downloads the metadata library. A fresh account imports no channels until you open **Categories**, select categories and press **Apply selection**. Checkbox changes are a draft until applied. The category screen shows saved/imported count separately from the current draft.

## Refresh reached “stage” and appeared to stop

Guide download, XML parsing, staged database import, merge and snapshot are separate steps. A large feed can take minutes; progress can remain on one stage while SQLite works. Check `status` for `guide.running`, phase, byte count, staged programme count and errors. Do not issue overlapping account changes or refreshes while a job is active. A failed Guide import should retain the preceding Guide; an upstream feed may be unavailable even if channel metadata downloaded correctly.

## Removed categories still appear in LG's Guide

First verify that Apply selection finished and the app reports the new saved count. Reopen the native Guide. If the backend count changed but the Guide did not, the likely problem is a stale native shared list or cached Guide model, not the checkbox UI.

The final implementation republishes the unchanged PBS policy, waits for the simplified channel cache, refreshes the UTP mapping and marks the Guide model dirty **before native app registration**. Its QML timer must allow an initial query while page readiness is false; waiting for readiness caused a dead end. Startup invalidates the Guide-only CRIU snapshot when code changes. Check that the three QML bind mounts are present and startup completed; see [architecture](ARCHITECTURE.md) and [recovery](RECOVERY.md).

Do not test removal/restoration by overwriting `settings.private.json` while someone is editing the real TV form. Apply the actual draft from the TV app. Do not send `changed:true` PBS notifications or restart UTP to force refreshes.

## Only one channel plays, or tuning does nothing

The first ZDF proof of concept bypassed parts of the full native tuning path. A working PoC stream alone did not prove a 21,000-channel native map worked. The final runtime uses selected categories, complete native IDs, policy/cache publication and the tuner-map reload. Make sure you are using the complete runtime and not mixing the old PoC Dmost URL or old provider with it.

Try a small category selection and use **Channels → Watch**. Read `player.active`, `readyState`, decoded width/height, error and advancing `currentTime` in status. A provider HTTP error, expired account, connection limit, incompatible codec or unavailable stream needs a different remedy than a stale native map. The app tests account acceptance but cannot guarantee each upstream channel.

If every channel goes black and `player.updatedAt` stops advancing while the services/native channel remain healthy, the embedded Dmost page may have stopped. The watchdog checks the TV's actual selection independently of that page and can either reload it or start a missing hidden player app, then replay the same selected channel. Check `playbackRecovery` counters, `reason`, `lastStage` and `lastError`. It excludes another foreground app, RF/foreign/locked channels and explicit native stop/block states, and limits attempts to once a minute. Missing-heartbeat recovery normally begins after 15–25 seconds, with additional startup/readiness time when the app itself must be recreated.

For an older runtime without this recovery, the following root-shell command reapplies the local player URL without changing the channel selection:

```sh
luna-send -w 15000 -n 1 luna://com.webos.service.wampluggable.dmost/setDmostUrl '{"url":"http://127.0.0.1:17651/player.html?v=full-3"}' < /dev/zero
```

A live missing-player recovery test is documented in the change log. Recovery of a stopped page does not establish the native lifecycle event that stopped it; no such event trace was available for the original failure.

If the hidden `com.webos.app.livedmost` app is absent after boot, its WAM methods may not respond at all. Reapplying the URL alone is insufficient in that state. The updated watchdog starts it through the application manager, loads the local page and resends the TV's selected channel. The earlier watchdog did not handle this case. Do not use a stale history entry to decide which channel to restore, and do not use the boot service's last-channel value as current selection; it returned a default RF channel during this investigation.

The page must acknowledge readiness before the native handoff. Also, launching LiveTV with the same selected channel may be accepted without retuning; the updated recovery uses the existing native broadcast binding and an explicit channel update. An `awaiting-playback` stage or an API acknowledgement alone does not prove picture/audio: verify active telemetry, decoded dimensions and advancing time, then the TV output.

## Player reports playback, screenshot is black

LG's compositor capture excludes hardware video. A black/missing video plane is expected in these screenshots. Confirm picture and sound on the TV itself; decoder dimensions/time provide supporting diagnostics, not proof of visible output. Native Guide may also show a “click to play” preview until selected.

On the tested firmware, a different native capture method **did** include Xtream video plus menus. The CLI `screenshot` command still uses the graphics-only compositor method. For a full capture on this TV, use the following root-shell command and retrieve the resulting PNG privately:

```sh
luna-send -w 18000 -n 1 luna://com.webos.service.capture/executeOneShot '{"path":"/tmp/tv-with-video.png","method":"SCREEN_WITH_SOURCE_VIDEO","format":"PNG","width":1920,"height":1080}' < /dev/zero
```

See the [webOS Homebrew screenshot commands](https://www.webosbrew.org/pages/commands-cheatsheet#screenshots) for other method/service variants. This was verified for our native Xtream playback; other firmware/input combinations remain untested. No captured video frames are bundled in this repository.

## Nothing starts after power-on

Allow roughly 60 seconds after a real boot. Confirm Homebrew Channel root/startup scripts, the `/var/lib/xtream-native/enabled` marker and both hooks. Check free space and boot logs. A firmware-profile/hash failure deliberately stops mounting incompatible files; review compatibility before regenerating anything. Remote power-off may suspend instead of rebooting.

On the tested TV, a full reboot returned LiveTV to its empty default terrestrial channel. The startup-resume worker now selects the last successfully watched imported Xtream channel from that specific fallback. Check `startupResume` in `/status`: it must reach `resumed` after actual video telemetry, rather than merely acknowledging a launch. It runs once per boot within five minutes, waits for native initialization, and cancels for another app or a real channel selection. Removed-category channels and missing history are skipped. A management-service restart does not trigger another selection; suspend/wake does not count as a reboot. The missing-player watchdog remains independent and does not choose history as its recovery target.

For slow startup, compare `startupResume.timings` (seconds of TV uptime). `serviceStarted` is recorded when the resume worker is constructed, after Node startup and initial settings/catalogue loading; use systemd's process-start timestamp when comparing whole-service overhead. `nativeReady` and `playerReady` identify readiness delays; `channelSelected` and `videoDecoded` separate tuning from decode. The measured faster-resume boot decoded video at 77.52 seconds: the process started at 67.14 and its resume worker was constructed at 69.69. That is a measured result for this setup, not a fixed boot-time guarantee.

## Native requests fail or Node aborts

The manager must use the resident provider's `native.sock` LS2 bridge. Do not replace it with repeated Node child-process `luna-send` calls. Standalone CLI calls on this firmware need `< /dev/zero`. Avoid feeding a script to the TV's Node 8 stdin when it spawns children; use a file or `node -e` instead. The host tool compresses long `node -e` scripts to fit Dropbear's remote-command limit.

## Guide times are wrong or rows are missing

Check the TV clock/timezone and provider XMLTV time offsets/EPG IDs. Only mapped IDs in selected categories and the import window appear. Different channel variants can share an EPG ID. Provider programme coverage can differ from available streams. Short EPG fallback updates only the current channel; it is not a substitute for a healthy full feed.

## TV UI or HDMI is disrupted

Stop the integration using [recovery](RECOVERY.md) and retain its private backups. Avoid restarting core tuner services or deleting firmware files. Preserve a working root SSH session before any real reboot. Optional debloat restoration and integration restoration are separate operations.
