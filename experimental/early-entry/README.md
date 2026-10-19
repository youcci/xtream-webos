# Manual early-entry experiment

Read [the findings and limitations](../../docs/EARLY_BOOT.md) first. This is optional, unsupported by LG, and **not enabled by the normal installer**. It was tested only on the recorded webOS 6.5.3 / 03.53.45 TV. It has not demonstrated sub-30-second video. Other firmware needs a new review; matching a pathname alone is insufficient.

The working runtime must already be installed and verified through a real Homebrew-started reboot. Keep key-authenticated root SSH and private backups. Do not run the fresh installer over an old PoC, replace an old installation's `control.sh` wholesale, or change Homebrew's core root-persistence files.

## 1. Check the entry and ABI

On the TV, inspect `systemctl cat tts.service` and its start script. The tested unit has optional `EnvironmentFile=-/var/systemd/system/env/tts.env`, runs as root, and executes a dynamically linked ARM32 soft-float shell. Its loader is `/lib/ld-linux.so.3`, with glibc 2.28. `/var` is writable and persistent when this unit starts.

The recipe below requires that `tts.env` **does not already exist**. An existing file needs a separate merge/backup plan. Record the original unit/script hashes privately. Verify `/bin/nice` and `renice` with a disposable process before enabling the priority lease. Audio Guidance was off during validation; enabled Audio Guidance has not been tested with this experiment.

## 2. Build from source

Use an existing Clang with ARM cross-compilation support and ELF `ld.lld`. No LG firmware or prebuilt library is distributed. Copy your own TV's `libc.so.6` to a private directory outside this repository, using root SSH. For example, on the computer:

```sh
umask 077
TV_LIBS_DIR="$HOME/webos-private-libs"
mkdir -p "$TV_LIBS_DIR"
ssh -i ~/.ssh/webos_tv root@TV_IP 'cat /lib/libc.so.6' > "$TV_LIBS_DIR/libc.so.6"
python3 experimental/early-entry/build.py --libraries "$TV_LIBS_DIR" --lld /path/to/ld.lld
```

The builder checks ELF class, machine and soft-float flags. Output is under ignored `dist/early-entry`; its build record contains local paths and must stay private. Confirm the ABI against your actual executable before loading anything. The public builder reproduced the tested library byte-for-byte.

## 3. Stage only the experiment's files

The runtime must include the current `start-node.sh`, service units, boot hooks and JS changes. For an existing installation, review its migration/update separately before proceeding.

Create `/var/lib/xtream-native/early-entry` as root, mode 0700. Copy these files there using your root SSH connection:

- `dist/early-entry/libxtream-early.so`
- `experimental/early-entry/dispatch.sh`
- `experimental/early-entry/priority-restore.sh`
- `experimental/early-entry/disable.sh`

Set all four files to root ownership and mode 0600; shell files are invoked through `/bin/sh`. OpenSSH `scp -O` can be used with a TV that lacks SFTP. Verify transferred hashes and `sh -n` on the three scripts. Do not copy private TV libraries into the installed experiment directory.

The dispatcher starts the existing boot job and requests LG's normal WAM unit only after its surface-manager condition is ready. It does not create an alternate player or overwrite a firmware executable. The temporary priority lease affects only Xtream processes and restores all their threads without a global systemd reload.

## 4. Test unarmed before changing TTS

On the TV root shell, with the experiment not armed:

```sh
set -e
test ! -e /var/lib/xtream-native/early-entry/armed
test ! -e /var/luna/preferences/webosbrew_failsafe
LD_PRELOAD=/var/lib/xtream-native/early-entry/libxtream-early.so XTREAM_EARLY_ENTRY=1 /bin/true
test -f /run/xtream-native/early-entry.claim
```

Inspect loader errors; a successful shell exit alone does not establish that a preload library loaded. The constructor claim proves it executed. Without `armed`, it must not write a new timestamp or dispatch a startup job. The claim deliberately prevents later invocations during this boot; reboot clears it.

## 5. Add the optional environment file

Run on the TV only after those checks pass. This creates a new file atomically and refuses to overwrite an existing one:

```sh
set -e
umask 077
mkdir -p /var/systemd/system/env
test ! -e /var/systemd/system/env/tts.env
cat > /var/systemd/system/env/tts.env.xtream-new <<'EOF'
LD_PRELOAD=/var/lib/xtream-native/early-entry/libxtream-early.so
XTREAM_EARLY_ENTRY=1
XTREAM_EARLY_DISPATCH=start
EOF
ln /var/systemd/system/env/tts.env.xtream-new /var/systemd/system/env/tts.env
rm /var/systemd/system/env/tts.env.xtream-new
: > /var/lib/xtream-native/early-entry/armed
```

No global `daemon-reload` is needed to read this environment on the next service start. Do not restart TTS repeatedly to simulate boot. Keep LG Developer Mode uninstalled. Wait until Homebrew's failsafe flag is absent before a real reboot:

```sh
set -e
test ! -e /var/luna/preferences/webosbrew_failsafe
luna-send -w 3000 -n 1 luna://com.webos.service.sleep/shutdown/machineReboot '{"reason":"remoteKey"}' < /dev/zero
```

This first lease permits one early attempt. Do not manually tune during measurement. After SSH returns, read `early-entry/marker.log`, the loopback `/status` response and service state. Confirm the saved channel, decoded dimensions, advancing time, root SSH, unchanged selection, Guide and sustained playback for at least three minutes. A successful launch reply is not a decoded frame.

## 6. Opt into health-based persistence

After the first healthy test, create both `early-entry/auto-rearm` and `early-entry/armed` with mode 0600, then perform another real reboot. The monitor reads the opt-in when the server starts. At least 90 seconds into a settled boot it can create the next lease. Resumed playback must advance for 30 seconds without a watchdog reload; a legitimate skipped app/channel is handled without retuning it. Failed startup, stale video, a failsafe flag or late service-restart state leaves the next boot to Homebrew.

Verify that `armed` was created automatically, then test a subsequent reboot **without touching it**. A one-shot successful test alone does not establish persistence. Ordinary Homebrew root/SSH startup remains independently installed.

## Disable before uninstalling or deleting the library

On the TV:

```sh
/bin/sh /var/lib/xtream-native/early-entry/disable.sh
```

This clears leases, removes the environment file only when it exactly matches this experiment, stops its own lease jobs, and retains the runtime and library. If someone added other environment settings, it stops and asks you to remove only the Xtream preload settings manually. **Remove the environment reference before moving or deleting the library.** Do not mask LG's LSM service or reload all units as cleanup.

Verify a normal Homebrew-started reboot before archiving the experimental directory or using the main uninstaller. Keep its logs and backups private. Standby/wake and firmware-update behavior remain outside this validation.
