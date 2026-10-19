# Recovery and removal

Keep root SSH available. Do not delete `/var/lib/xtream-native` before restoring its backups and bindings. The fresh installer retains private pre-install snapshots; old manual/PoC setups may have different backups and must follow [migration](MIGRATION.md).

If you manually enabled the [early-entry experiment](EARLY_BOOT.md), run `/bin/sh /var/lib/xtream-native/early-entry/disable.sh` first. It clears leases and removes only its exact environment file while retaining the library and normal Homebrew startup. Resolve any additional environment settings manually. Remove the preload reference before deleting its library or the runtime; the default uninstaller does not install/manage this optional system-service extension.

## Stop playback/services temporarily

On the TV root shell:

```sh
/var/lib/xtream-native/control.sh stop
```

This restores the stock Dmost page URL and stops the two Xtream systemd services. It does **not** restore stock channel rows/feed, remove QML mounts or disable the next boot. To start again, run `control.sh start`.

## Restore the stock IP integration

For an installation made by this repository's installer, from the computer:

```sh
python3 tools/xtream_webos.py --host TV_IP --key ~/.ssh/webos_tv uninstall --restore-lg-channels
```

The tool requires and integrity-checks `backups/channels-before.sqlite` before making changes. It disables the runtime, removes its three startup hooks, stops boot preparation and runtime services, removes owned Xtream IP rows/categories and restores the saved non-Xtream IP rows **without replacing the whole database or RF tables**. It removes owned programme rows, unmounts the three Guide overlays and PBS mask, invalidates the Guide-only snapshot, and asks the original PBS service for its policy to reactivate it.

Remove **Xtream TV** through Home's app editor. Perform a real reboot and verify normal LiveTV/Guide behavior; original LG programme data may need to download again. The saved Guide backup is retained for diagnosis, rather than automatically replacing the running whole Guide database. Private runtime/backups remain under `/var/lib/xtream-native` until you explicitly archive/remove them. Root and optional debloat are retained.

If LG Channels or another built-in launcher was logically removed, restore it separately using [debloat undo](DEBLOAT.md#undo-optional-debloat). Restoring the feed alone does not undo logical app removal. Downloaded apps need store reinstallation.

The fresh uninstaller is covered by offline structure/packaging checks and code review, but has not had a complete clean-install/uninstall round trip on another physical TV. Keep an off-TV backup before relying on it.

## Disable next-boot integration when startup fails

On the TV root shell:

```sh
rm -f /var/lib/xtream-native/enabled
rm -f /var/lib/webosbrew/init.d/40-native-xtream
rm -f /var/lib/webosbrew/init.d/55-disable-lg-channels
rm -f /var/lib/webosbrew/init.d/60-native-xtream
systemctl stop xtream-native-boot.service xtream-native.service xtream-native-provider.service
```

These commands stop further bootstrap changes. Bind mounts are temporary and disappear on a real reboot. They do not restore deleted stock IP rows; retain the database backup and use the uninstaller/targeted restore. Do not remove unrelated Homebrew hooks or core systemd services.

If SSH works and you want to remove mounts before rebooting, first restore the stock player URL:

```sh
luna-send -w 15000 -n 1 luna://com.webos.service.wampluggable.dmost/setDmostUrl '{"url":"file:///usr/palm/applications/com.webos.app.livedmost/index.html"}' < /dev/zero
```

Then unmount only targets that are currently bind-mounted in `/proc/mounts`:

```sh
umount /usr/palm/applications/com.webos.app.livemenu/qml/Controllers/ChannelInterfaces/Interfaces.qml
umount /usr/palm/applications/com.webos.app.livemenu/qml/Pages/Page1/Components/SettingPopupFeed.qml
umount /usr/palm/applications/com.webos.app.livemenu/qml/main.qml
umount /usr/sbin/pbs
```

An “not mounted” response means that particular mount is already absent. Do not remount the firmware writable or copy patched files into it.

## Installation stopped partway

- **Only `.install-tmp` exists:** database/native-service mutation has not yet started. Check whether it contains backups, keep them privately, and inspect the error. After resolving the issue you may archive/remove this staging directory and retry. Never delete a working `/var/lib/xtream-native` to force a fresh install.
- **`/var/lib/xtream-native` exists:** the activation step may already have masked the feed or changed IP rows. Disable hooks and stop services as above, keep backups, and use the restore tool if its backup is present. Fix the actual compatibility/storage problem before another attempt.
- **Runtime starts but launcher installation fails:** retain the runtime and use `package` to rebuild a private launcher. Investigate the TV installer error; do not keep rerunning fresh install over existing backups. Manual package installation uses the TV's existing rooted installer, not LG Developer Mode.
- **Schema/hash changed after firmware update:** disable hooks, preserve private originals/profile/backups, and review the new native implementation. Do not force old overlays onto new firmware.

For serious rooting problems, follow [webOS Homebrew's recovery guidance](https://www.webosbrew.org/rooting/). Do not factory-reset or downgrade as a routine cache-refresh step.

## Guide-only snapshot reset

The start script handles this when code hashes change. For diagnosing a known compatible overlay, the relevant snapshot metadata paths are:

```text
/tmp/checkpoint/com.webos.app.livemenu/pgid
/mnt/lg/cmn_data/checkpoint/com.webos.app.livemenu/pgid
/tmp/checkpoint/hash_check_com.webos.app.livemenu
```

Only the Guide process should be terminated after invalidation, allowing a fresh launch to create a new snapshot. Do not clear all checkpoints, restart UTP or delete native databases to refresh channels.
