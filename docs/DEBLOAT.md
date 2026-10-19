# Optional debloat and app removals

Debloat is separate from the native Xtream installer. Keep Home, LiveTV, HDMI/input switching, Settings, IEPG, UTP and Dmost intact. Disabling app preloads can reduce background residency; hiding a tile alone does not establish a performance improvement. No controlled before/after performance benchmark was recorded.

## What was done on the development TV

- Disabled LG Channels, browser and later Alexa preloading while retaining Home, LiveTV and HDMI preloads.
- Turned off `homePromotion`, `sportsAlarm`, `webOSPromotionVideo` and `contentRecommendation`. `livePromotion`, `promotionStreamer` and `livePlus` were already off.
- Inspected the default 31 ad/SDK/demo/remote targets; they already reported `visible=false`.
- Removed the optional apps listed below, and logically removed the built-in Alexa, Sport-Alarm and LG Channels entries.
- Replaced the stock LG IP feed with the native Xtream provider. That replacement belongs to the integration installer, not the generic debloat script.

## Adapted upstream script

[`webos-debloat-webos6.sh`](../debloat/webos-debloat-webos6.sh) is an MIT snapshot of [lucataco's script](https://gist.github.com/lucataco/7c303b443934008a9031a55cfca552ec), upstream revision `ecc48489e07ae7e51680651e84c3ed87de9d7d0a`. The [compatibility diff](../debloat/webos6-compatibility.patch) records the local changes.

The tested webOS 6 firmware uses `blockedAppList` / `blocked_applist`, rather than the newer `blockedSystemAppList` format. It also needs Luna CLI stdin kept open. The regional block list was rewritten during startup, so the final development setup uses a **preload-only boot hook**. Do not treat the upstream script's general firmware-update assurances as validation for this native integration.

From the cloned repo on the computer:

```sh
ssh -i ~/.ssh/webos_tv root@TV_IP 'mkdir -p /var/lib/webos-debloat; chmod 700 /var/lib/webos-debloat'
scp -i ~/.ssh/webos_tv debloat/webos-debloat-webos6.sh root@TV_IP:/var/lib/webos-debloat/webos-debloat.sh
scp -i ~/.ssh/webos_tv debloat/50-debloat root@TV_IP:/var/lib/webosbrew/init.d/50-debloat
ssh -i ~/.ssh/webos_tv root@TV_IP
```

The following commands run **on the TV's root shell**:

```sh
S=/var/lib/webos-debloat/webos-debloat.sh
chmod 700 "$S" /var/lib/webosbrew/init.d/50-debloat
sh "$S" --list
sh "$S" --plan
sh "$S" --preload-off --dry-run
sh "$S" --settings-off --dry-run
sh "$S" --preload-off
sh "$S" --preload-off --id amazon.alexa.view
sh "$S" --preload-off --id amazon.alexapr
sh "$S" --settings-off
sh "$S" --status
```

The default preload targets are LG Channels and the browser. Explicit Alexa commands cover both Alexa app IDs; missing policies/settings can be skipped by the script. The hook replays saved preload changes at boot. Do not also run its generic `--install-boot-hook`, which installs a broader hiding/replay hook over the same hook name.

`--apply` hiding is available for reviewed individual targets, but persistent broad hiding was not needed on this TV. Never delete firmware directories to imitate an uninstall.

## Requested apps and exact IDs

IDs and availability can vary by region/version. Inspect `--list` first and match the app's title. The eleven downloaded apps were removed through the TV installer; all fourteen requested titles were absent from the launcher/registry after reboot. Alexa has two IDs, hence fifteen IDs overall.

| Requested title | ID on the tested TV | Method |
| --- | --- | --- |
| Rakuten TV | `ui30` | Uninstall downloaded app |
| Sport-Alarm | `com.webos.app.sportsteamsettings` | Built-in logical removal |
| Amazon Alexa | `amazon.alexa.view`, `amazon.alexapr` | Built-in logical removal |
| Plex | `cdp-30` | Uninstall downloaded app |
| Spotify | `spotify-beehive` | Uninstall downloaded app |
| DAZN | `dazn` | Uninstall downloaded app |
| LG Channels | `com.webos.app.lgchannels` | Built-in logical removal + integration replaces its feed |
| LG Radio + | `com.twin.app.audiochannel` | Uninstall downloaded app |
| LG Travel + | `com.lgtravel.app` | Uninstall downloaded app |
| Just Dance Now | `com.ubisoft.lg.justdancenow` | Uninstall downloaded app |
| LG Sports Playbook | `epoxyaisports` | Uninstall downloaded app |
| LG Movies & TV | `com.lgtvod.app` | Uninstall downloaded app |
| LG Streaming Week | `webos.day` | Uninstall downloaded app |
| 8 Pool / 8 Ball Pool | `com.miniclip.eightballpool` | Uninstall downloaded app |

For downloaded apps, open Home's app editor and uninstall the matching title. This is sufficient and gives an immediate result. The development automation used `com.webos.appInstallService/dev/remove` with a subscription and waited for terminal status **31**; a first `returnValue:true` acknowledgement alone is not proof of uninstall. Reinstall downloaded apps later from the LG store if available; local app data may be lost by uninstalling.

For the four built-in IDs, the included helper merges them into LG's `deletedSystemAppList.json` `deletedList`. It creates a private baseline backup and leaves firmware files in place. It does not remove core TV runtime services.

From the computer:

```sh
scp -i ~/.ssh/webos_tv debloat/builtin-apps.js root@TV_IP:/tmp/xtream-builtin-apps.js
ssh -i ~/.ssh/webos_tv root@TV_IP 'node /tmp/xtream-builtin-apps.js --plan'
ssh -i ~/.ssh/webos_tv root@TV_IP 'node /tmp/xtream-builtin-apps.js --apply'
```

Review the plan, then perform a real reboot when ready. Keep the helper available in this repo for restoration. This preset is optional; the native channel integration can work without hiding these launcher entries. It does not remove your antenna/cable/satellite channels or unrelated downloaded apps.

## Undo optional debloat

On the TV root shell:

```sh
rm -f /var/lib/webosbrew/init.d/50-debloat
S=/var/lib/webos-debloat/webos-debloat.sh
sh "$S" --preload-on
sh "$S" --settings-restore
sh "$S" --restore
node /tmp/xtream-builtin-apps.js --restore
```

Copy the helper again if `/tmp` was cleared. Its restore removes only preset IDs that were not already removed in the saved baseline and retains unrelated later list edits. Keep `/var/lib/webos-debloat` and `/var/lib/xtream-webos-debloat` private for their backups. Reboot to refresh logical built-in removals. This does not restore the stock IP feed; use [integration recovery](RECOVERY.md) separately.
