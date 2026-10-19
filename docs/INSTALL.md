# Installation and everyday use

The public installer is for a **fresh rooted compatible TV**. It deliberately refuses existing manual installations. The runtime works on the recorded development TV; this newly packaged installer has not been exercised as a fresh installation on a second physical TV. See [compatibility](COMPATIBILITY.md).

## Prerequisites

- Persistent root and Homebrew Channel startup scripts enabled; LG Developer Mode uninstalled.
- Working key-authenticated root SSH from your computer, including a trusted `known_hosts` entry.
- Python 3.9+ and OpenSSH on the computer. Git is needed to clone; no npm install is needed.
- The TV's Node.js, SQLite, curl, systemd, `luna-send`, `webos-service`, native LiveTV/Guide, IEPG, UTP and Dmost. Do not replace the TV's Node binary with a desktop build.
- A live Xtream account and enough free persistent storage for metadata, database backups and a Guide snapshot. The development Guide snapshot was approximately 100 MB; provider feeds vary. Check `df -h /var/lib /mnt/lg/cmn_data /tmp` on the TV.

## 1. Clone and inspect

```sh
git clone https://github.com/youcci/xtream-webos.git
cd xtream-webos
python3 tools/xtream_webos.py --host TV_IP --key ~/.ssh/webos_tv doctor
```

The diagnostic reads the native IP/genre/Guide schemas and QML anchors without changing native data or services. Required output includes `compatible: true`, `channelColumns: 116`, `qml: "anchors-match"`, required dependencies present, and `developerModeInstalled: false`.

`existing-xtream-overlay` or `existingInstallation: true` means to stop and read [migration](MIGRATION.md). Schema/anchor errors must be investigated rather than skipped. A different webOS 6 model/firmware additionally needs `--experimental` on install; that flag does not bypass structural checks or add support for another webOS major version.

## 2. Install

**This replaces the stock IP-source lineup and any other custom IP-source rows.** It leaves RF tuner tables intact. Read [recovery](RECOVERY.md) first, particularly if the LG Channels launcher was also removed.

```sh
python3 tools/xtream_webos.py --host TV_IP --key ~/.ssh/webos_tv install --replace-lg-channels
```

The tool:

1. Validates root, dependencies, firmware profile, schema and unmodified QML anchors.
2. Stages the runtime under `/var/lib/xtream-native.install-tmp` with private permissions.
3. Generates three QML overlays from the owner's firmware, preserving originals privately.
4. Uses SQLite `.backup` to save the channel database and any existing Guide database, plus available original provider replies.
5. Moves the runtime into `/var/lib/xtream-native`, installs startup hooks `40-native-xtream`, `55-disable-lg-channels` and `60-native-xtream`, and marks it enabled. The early hook queues a Linux systemd boot job while unrelated preload hooks continue; the late hook retries/reuses the same job.
6. Masks the stock PBS feed, starts a local replacement provider and manager, restores/initializes Guide tables, mounts overlays, and sets the native Dmost player URL.
7. Generates a private launcher IPK, installs it and checks the installer's final success state and app registry.

On-TV backups are under `/var/lib/xtream-native/backups/`. Copy that directory off the TV to private storage before further customization. Do not publish it. Installation does not reboot automatically. If it stops partway, use [recovery](RECOVERY.md); repeated installs deliberately refuse to overwrite the staged/runtime directories and backups.

## 3. Enter an account on the TV

```sh
python3 tools/xtream_webos.py --host TV_IP --key ~/.ssh/webos_tv open
```

Or launch **Xtream TV** from Home. The app interface is branded **Channel Room**. Its public app ID is `io.github.youcci.xtreamwebos`.

In **Account**, enter a server such as `https://provider.example:443`, username and password in their separate fields. Do not paste an M3U URL containing credentials. Choose refresh intervals and select **Save & sync**. An unchanged account can retain its saved password when the password field is blank.

Wait for the live-channel metadata download to finish. A fresh account starts with no categories selected. This is intentional; it avoids importing a huge provider library automatically.

## 4. Choose categories and apply

1. Open **Categories**. Search by country, language or category name.
2. Use arrows and OK to toggle categories. Start with a few categories.
3. Choose **Apply selection**. Checkbox changes alone are only a draft.
4. Wait for completion. The job applies native rows, republishes policy to rebuild LG's native cache and refreshes its tuner mapping. A separate Guide download/import can continue afterward.
5. Select **Open TV Guide**, or browse **Channels → Watch**.

**Select all** and **Clear** affect all categories, including categories hidden by search. Removing a category and applying removes its native channels, genre entry and obsolete programme rows; it remains available unchecked in the metadata selector.

Reopen LG's Guide after a completed update. Its patched cached process refreshes channels and genres on launch. Changing an account begins with an empty category selection; account credentials are not reused in another account's active channel mapping.

For native category browsing, open **TV Guide → ⋮ → Filter → Genre** and select an imported category. Use **All** to return to the complete selected lineup. The labels follow the TV's system language.

## 5. Background refresh and persistence

Default channel refresh is 6 hours and full XMLTV Guide refresh is 60 minutes. Between full refreshes, short-EPG updates target the currently playing channel, at up to 15-minute intervals. The worker checks once a minute while running. A failed full feed can fall back to the current channel's short EPG.

The TV retains selected IDs, a stable channel-number assignment ledger, the full library metadata and the selected native catalogue. Unselected channel metadata does not appear in LG LiveTV. Refreshes preserve LG editor favourites, locks, skip flags and groups when the same channel IDs remain in the same account.

Homebrew startup hooks restart everything after a real reboot and restore a persistent Guide snapshot into the volatile `/tmp/epg` database. Startup can take about a minute. Overdue refreshes catch up after startup; the service cannot update while the TV is fully off. Verify one real reboot after initial setup while root SSH recovery remains available.

## Useful commands

All global options precede the subcommand:

```sh
python3 tools/xtream_webos.py --host TV_IP --key ~/.ssh/webos_tv status
python3 tools/xtream_webos.py --host TV_IP --key ~/.ssh/webos_tv screenshot --output tv.png
python3 tools/xtream_webos.py --host TV_IP --key ~/.ssh/webos_tv package
```

`status` excludes account credentials, but includes channel names and playback state. Screenshots show the current compositor UI and exclude the hardware video plane; review them before sharing. `package` rebuilds a token-bearing per-TV launcher under ignored `dist/`. Keep it private.

For maintenance over root SSH:

```sh
/var/lib/xtream-native/control.sh stop
/var/lib/xtream-native/control.sh start
```

`stop` stops any boot-preparation job plus the two runtime services and restores the stock Dmost player URL. It does not restore the LG IP feed, stock IP rows or QML bindings; use the [uninstaller](RECOVERY.md) for that. `restart` only restarts the two runtime services; after changing overlays use `start` to run its compatibility/checkpoint handling.
