# Experimental startup before Homebrew

This investigation found a persistent Linux entry point earlier than Homebrew on the tested webOS 6.5.3 firmware. It has **not achieved playback in under 30 seconds**. Two consecutive final boots observed decoded video at **39.23 and 39.15 seconds of TV uptime**. The first automatically armed the second through health checks; no manual tuning or re-arming was used for that repeat.

This is a manually deployed experiment, not an LG-supported extension or a default installation feature. The normal [installation](INSTALL.md) still uses Homebrew startup hooks. Original source, a reproducible builder and a [manual deployment/rollback recipe](../experimental/early-entry/README.md) are included. Another firmware must first be checked for the same service, writable environment file, executable ABI and startup behavior.

## The earlier entry point

The shipped `tts.service` reads an optional environment file at `/var/systemd/system/env/tts.env`. Unlike the read-only systemd unit directory and volatile `/run`, this location persists across reboot. A root-owned environment file can supply an `LD_PRELOAD` reference to an independently built library on writable storage.

The prototype uses an ARM32 soft-float library matching the tested TTS executable. Its constructor ran as root at approximately **15.7–16.4 seconds**, before the first Homebrew user hook. This establishes an earlier entry point; it does not establish that the TV's channel database, player, network or display are usable at that instant.

The constructor does not replace TTS functions or run the Node server inside TTS. After checking its enable flag, root UID, the Xtream enabled marker and Homebrew's failsafe flag, it consumes a one-use lease and submits a separate Linux startup job. Child dispatch clears the experiment's preload environment so it is not inherited by the application stack.

The library and dispatcher live under `/var/lib/xtream-native/early-entry`. No kernel, root filesystem, bootloader or TV-service partition was rewritten. A library loaded into a system service still carries risk: an incorrect ABI or constructor failure can affect that service even when channel startup is not armed.

## One boot at a time

There are two independent guards:

- An `armed` file is atomically renamed to `claimed` before dispatch. Without another lease, the next reboot falls back to ordinary Homebrew startup.
- A private `early-entry.claim` under `/run/xtream-native` prevents a later TTS restart in the same boot from consuming a lease intended for the next boot. The separate `startup-resume.claim` prevents the manager from selecting the saved channel again after its own restart.

An optional health monitor can re-arm the next early attempt only after the boot has settled. It waits until at least 90 seconds of uptime and, for a resumed stream, requires progressing decoded playback for 30 seconds without a watchdog reload. An intentional switch to another app or channel is handled separately so the monitor does not force playback back to the saved channel. The experiment must explicitly enable automatic re-arming; the default installer does not enable the early loader.

The lease limits repeat dispatch after a failed early startup. It does not make an invalid preload library safe to leave installed. Homebrew's root startup, failsafe behavior and SSH recovery remain separate from the experiment.

## Measurements and their limits

Times below describe different runs and stages, not one combined boot trace.

| Observation | TV uptime | What it establishes |
| --- | ---: | --- |
| Earlier normal Homebrew hook | roughly 38–50 s | Starting only from this hook cannot meet a 30 s target. |
| TTS library constructor | roughly 15.7–16.4 s | Persistent root code executes before Homebrew. |
| Final boot 1: root / selection / decoded video | 15.69 / 30.64 / 39.23 s | Saved-channel playback and automatic next-boot health lease. |
| Final boot 2: root / selection / decoded video | 16.16 / 28.48 / 39.15 s | Repeat using the automatically renewed lease, with no manual tuning. |
| Run without the late global reload | 44.04 s | Playback remained healthy beyond 150 s with no watchdog reload. |

Decoded playback means fresh player telemetry reported active video with nonzero decoded dimensions. It is not a panel-level stopwatch measurement. Process start, a successful app launch and a playing flag alone are insufficient evidence of a visible frame.

Boot timing varies. These measurements do not promise the same result on every reboot, another TV, another firmware, or a slower upstream stream. No external Linux computer was required for these tests; the TV still uses its native Dmost video integration.

## Why stock Live TV selects RF

On the tested firmware, the shipped Live TV QML deliberately requests the last **RF** channel during an ordinary boot. It requests the last channel across input types in other paths. This explains why remembering the last IP channel in UTP is insufficient to make stock startup select it.

The existing resume controller uses Live TV's ordinary `channelChange` launch parameters to select the saved imported channel, retaining the native selection and lock path. It first checks that Live TV is foreground and LG's exact empty RF fallback is still selected. Another app, a real RF channel, changed history or a different channel cancels resume. Before its first Live TV observation, the controller allows LG Home until 90 seconds of boot uptime without tuning over it. Persistent Home or returning Home after Live TV cancels resume. The opt-in player bootstrap also stays available for up to 90 seconds after it starts; ordinary bootstrap retains its 30-second limit.

No additional Live TV QML overlay was deployed for this experiment. The native input app may already have loaded its QML or been restored from a snapshot before the early loader runs, so a late file overlay is not proof that the running app will use it.

## Keep native bindings alive

Native UTP broadcast bindings belong to their Luna client connection. A `broadcastId` obtained by a short-lived CLI process is not a durable handle for a later process. This can make a command sequence appear to initialize correctly while subsequent reads or tuning fail.

Use the resident provider's connection and private IPC bridge for binding and subsequent native operations. Standalone CLI probes on the tested firmware also need stdin kept open, but that addresses a separate EOF behavior; it does not extend a binding beyond the client's lifetime.

A separate small native LS2 warmer was built and tested privately. Its own regular role allowed only the application-manager and broadcast service names; unrelated service calls were explicitly denied. Same-handle reads worked, but real boot trials still reached video around 40–43 seconds. During one boot LG delayed current-channel replies until about 28–34 seconds. A short launch timeout also risked canceling an unconfirmed request. This helper did not establish an improvement: it was removed from automatic startup and its three additional LS2 metadata files were removed. Its failed experiment is not a required part of the published loader.

Selecting the IP channel while omitting guarded player prelaunch also failed to improve startup: the hidden app remained absent and ordinary watchdog recovery reached video at 62.61 seconds. The retained configuration prepares the hidden player and runs ordinary native channel selection in parallel, with the existing foreground/empty-fallback checks.

## A late reload can restart the whole player engine

One priority-restoration experiment initially decoded video, then lost the hidden player around 64 seconds. AirPlay called this a web-engine crash, but later unit execution records identified a **clean systemd stop/start** instead.

The restoration script called global `systemctl daemon-reload` after `/tmp/boot-done` existed. The shipped `lsm-ready.path` was re-evaluated, and `lsm-ready.service` passed its boot-completion condition. That service explicitly stops and starts `webapp-mgr.service`, then booster and Maliit. All web players disappear when WAM stops; the Xtream watchdog subsequently recreated its hidden player.

The timing was direct: one reload finished at 66.14 seconds, the LSM service condition passed at 66.169 seconds, and the new WAM process started at 66.632 seconds. Its restart counter stayed at zero because this was an explicit stop/start, not automatic crash recovery. Earlier retained logs showed the same sequence near 64 seconds.

The correction removes the late global reload and restores process priorities directly. **Do not mask LG's LSM service to hide this symptom.** Avoid unnecessary global reloads after boot completion, and always validate sustained playback through the later boot window. Upstream [systemd path-unit coldplug handling](https://github.com/systemd/systemd/blob/v244/src/core/path.c#L441-L455) explains how a reload can recheck a waiting path; the on-device execution records establish what occurred on this TV.

## Disabling or removing the experiment

Keep working root SSH access and the ordinary Homebrew startup path available before changing the loader. Retain the pre-experiment environment file and the working runtime so rollback does not depend on early dispatch succeeding.

Disable re-arming and clear any pending early lease first. Then remove this experiment's preload reference and environment variables, or restore the original environment file if one existed. **Remove the environment reference before deleting or moving its library.** Only remove an entire environment file when the experiment created it and it contains no unrelated configuration.

Verify ordinary startup and recovery before deleting the remaining experimental files. Uninstalling the Xtream manager must not leave a system service pointing to a missing library. These are rollback requirements for the manual experiment, not evidence that the default uninstaller manages this optional loader.

## Still unresolved

- Consistent playback below 30 seconds remains unproven. Executing code at 16 seconds does not remove later channel-map, native-client, page and decoder work.
- Broader firmware compatibility and a repeatable fresh early-loader installation/removal have not been validated.
- The tested native helper did not beat the retained path. The observed native-query and media-startup delays have not been removed; they are measurements, not proof of an immutable hardware minimum.
- Normal reboot, snapshot restoration and standby are different paths. The current evidence concerns real reboot startup; it does not establish a new suspend/wake implementation.
