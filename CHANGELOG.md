# Change log

## Unreleased — startup Home allowance (2026-10-23)

- Investigate a power-on black screen with both services and current channel/Guide refresh healthy. The TV was on its empty terrestrial fallback, the hidden player was absent, and startup had canceled with `another-app` after early foreground-query failures. The earlier status did not retain that app's identity. Selecting the saved imported channel allowed the existing guarded watchdog to recreate the player and restore decoded 720p video.
- Allow initial LG Home until 90 seconds of boot uptime, without launching over it. Still cancel for other apps, actual channel selections, persistent Home, or Home after Live TV was observed. Record only a coarse foreground class in resume diagnostics. Extend opt-in player preparation through delayed startup; normal preparation keeps its 30-second deadline.
- Add five regression cases for transient/persistent Home, delayed player readiness and user app changes. All 101 offline tests pass. A baseline reboot decoded at 39.59 seconds; a reboot with the correction decoded at 44.54 seconds, without manual tuning or watchdog recovery. These trials validate normal reboot startup; the original intermittent non-TV foreground sequence was not reproduced.

## Unreleased — persistent entry before Homebrew (2026-10-19)

- Add original ARM32 soft-float loader source, reproducible owner-libc build, manual deployment and guarded removal for an optional TTS environment-file entry. It ran as root around 16 seconds without modifying read-only firmware or Homebrew's persistence code. The default installer does not enable it.
- Use an atomic one-use lease, boot-local dispatch claim and health-based renewal after at least 90 seconds. Failed startup leaves the next boot to Homebrew. Preserve SSH and Developer Mode removal.
- Validate the exact saved native IEPG row before early resume and defer bulk native/channel/Guide work until playback or bounded fallback. Reuse the server for guarded player preparation; retain user-selection, foreground, native lock and once-per-boot guards. Avoid unused startup crypto/TLS initialization without changing management-token entropy or exposing upstream URLs.
- Restore temporary Xtream process priorities without global systemd reload. Unneeded late reloads had re-triggered LG's LSM path, cleanly restarting the entire web-app engine; unchanged unit files now skip reloads.
- Consecutive final real reboots observed decoded 720p video at **39.23 and 39.15 seconds**, with no manual tuning. The repeat consumed an automatically renewed lease. Account/category/catalogue hashes remained unchanged. Sub-30-second video remains unachieved; the measurements do not establish a fixed hardware minimum or a cross-firmware guarantee.
- Reject the standalone native warmer and native-selection-only trials: neither improved the retained configuration. Remove the warmer's automatic job and its three additional LS2 metadata files. Keep owner-specific logs, frame captures and copied TV libraries private.

## Unreleased — boot timing follow-up (2026-10-19)

- Start provider/manager after compatibility checks, Guide restoration and overlay mounts, allowing their initialization to overlap the independent Guide checkpoint hash check.
- A physical reboot resumed decoded 720p video at 66.69 seconds with no manual tuning. The earlier 55.88-second measurement remains valid for its recorded boot; LG/Homebrew startup timing varies, so this follow-up does not establish a faster overall boot or a sub-30-second result. On the earlier boot the first supported Homebrew hook already started at 38.59 seconds, preventing a sub-30 result through that hook path.

## Unreleased — early Linux boot preparation (2026-10-19)

- Queue an on-TV Linux systemd oneshot from the earlier `40-native-xtream` hook. Restore Guide/overlays and start the integration in parallel with unrelated preload work. The late hook reuses the same job and retains its legacy fallback; root persistence scripts stay intact.
- Wait for actual hidden-player registration before sending its WAM URL method. Start provider and manager concurrently, with an explicit private-bridge readiness gate before native map updates.
- Defer parsing the full unselected provider library until category management or metadata refresh needs it. Preserve the selected catalogue and existing category/refresh behavior.
- Add boot/player readiness and hook execution tests; extend packaging, fresh-install and removal paths for the early job. These changes do not replace the native player or require an external Linux computer.
- Physical reboot validation: the earlier sequential-provider variant decoded at about 63 seconds. With parallel service startup and lazy library loading, the resume worker was constructed at 45.65 seconds uptime, native/page readiness was observed at 49.88, the channel was selected at 53.48 and decoded 720p video was observed at 55.88. Host polling saw the first decoded frame about 54.8 seconds after the reboot request, without manual tuning. These are measurements for the recorded TV/account, not a guarantee for every boot or provider.
- Playback remained healthy past four minutes of uptime with no watchdog recovery. A video-layer capture confirmed the picture; category selection, account settings and selected catalogue were preserved, and restored Guide rows and all three QML mounts were verified. Fresh installation/removal on another TV remains untested.

## Unreleased — faster startup resume (2026-10-19)

- Replace the fixed ten-second service grace with actual native database/map and page readiness. Poll every second, then require two seconds of stable fallback selection before tuning. A missing page still gets a bounded ten-second grace before the existing recovery fallback. Retain foreground, channel ownership, native lock handling and once-per-boot guards.
- Back off failed native probes for five seconds despite the faster normal polling. Add boot-relative stage timings so startup delays can be measured without confusing a launch acknowledgement with decoded playback.
- Add regression cases for early selection after actual readiness and bounded missing-page fallback; sixteen resume cases now cover the faster path and existing exclusions.
- Physical reboot validation without manual tuning: service process started at 67.14 seconds uptime, resume worker constructed at 69.69, native/page readiness observed at 72.52, channel selected at 75.54 and decoded 720p video observed at 77.52. The preceding measured boot first showed decoded video at 90.03 seconds (process start 63.25). Observed process-start-to-video time fell from about 26.78 seconds to 10.38; total boot time varies before the integration starts.

## Unreleased — last-channel startup resume (2026-10-19)

- Resume the last successfully watched, still-imported Xtream channel once per real boot when LiveTV starts on LG's empty terrestrial fallback. Wait for native initialization and two stable fallback observations; cancel for another app or selected channel. Normal native selection retains parental-lock handling.
- Exclusively create a private marker on boot-local `/run` tmpfs so a management-service restart cannot change the selected channel again. The tested TV repeats its kernel boot ID, so that ID is not used. Bound resume to the first five minutes of uptime and send at most one selection even if its acknowledgement is lost.
- Expose sanitized `startupResume` status and require fresh decoded video telemetry before reporting success. Keep missing-player recovery independent of history-based startup selection.
- Add fourteen offline regression cases for startup, persistence, eligibility, user input and failure handling.
- Physical validation: the last watched channel resumed automatically after a real reboot, without any manual tune command, with active decoded 720p video at about 90 seconds of uptime. After correcting the repeated-kernel-ID issue, a second real reboot verified that the `/run` marker reset and automatic resume worked again. A same-boot management-service restart skipped resume and retained playback.

## Unreleased — cold-start player recovery (2026-10-19)

- Observed a recurring black screen after a real reboot: the hidden native player app was absent, no player telemetry had arrived, and its WAM methods timed out. The first recovery worker could not progress because it queried that absent player before starting it.
- Read actual selection through the native UTP binding/current-channel path. This works independently of the player and avoids the TV adapter's caller restrictions. Check foreground, import ownership and explicit unlocked state before starting the hidden player, loading the page and replaying the still-selected channel.
- Handle partial startup with fresh but inactive telemetry and an uninitialized native channel. Add bounded launch readiness, selection-change guards and stage-specific diagnostics. No historical/default channel fallback is used.
- Wait for the page's actual `app_ready` acknowledgement before replay. LiveTV's duplicate UI channel selection was a no-op, so use UTP's existing binding and `changeChannel` with `update:true`. A live LS2 trace confirmed that this emits the native Dmost `setChannel` for the same selected channel.
- Expand the playback regression suite from seven to fifteen cases, including cold startup, RF/locked exclusions, partial startup, user selection changes, failed launch readiness and missing page acknowledgement.
- Verified the missing-app path on the TV by closing the real hidden player app. Independent selection reads continued working while it was absent; automatic recovery started it once, reloaded once and performed one native replay, restoring the same channel at 720p after 26.9 seconds.
- Subsequently verified a complete TV reboot with Developer Mode absent. Both services, all 1,259 selected channels and Guide data returned. LG initially selected its default terrestrial channel; selecting the previously watched Xtream channel restored active 720p playback without watchdog intervention. A video-inclusive native capture confirmed a rendered frame. This boot exercised normal startup; the separate app-close test exercised missing-app recovery.

## Unreleased — missing-player recovery (2026-10-19)

- Diagnosed all-channel black video with healthy native channel/Guide data and working upstream HLS. The embedded player's heartbeat had stopped; reapplying its local Dmost URL restored playback, with picture/audio confirmed by the owner.
- Added a guarded watchdog that checks for a missing heartbeat only, verifies foreground LiveTV and an owned/unlocked native channel, then reloads the page. It leaves account/category data intact, skips healthy/other-input playback and limits attempts to one per minute.
- Added sanitized recovery status and seven offline regression tests. The earlier native lifecycle event that dropped the page was not captured.
- Verified recovery on the physical TV by loading a temporary player with muted snapshot telemetry, restoring the normal source, and allowing the watchdog to act. It reloaded once after 18.6 seconds and restored active 1080p playback on the same channel. The temporary probe is not part of the runtime or published source.

## 0.1.0 — 2026-10-19

First public source release, collecting the rooted-TV integration and reproducible setup notes.

- Recorded the successful webOS 6 SlopBro/Homebrew setup and Developer Mode removal before reboot.
- Adapted MIT webos-debloat for the tested older block-list schema and Luna stdin behavior; retained a preload-only boot policy.
- Documented and provided restoration for requested optional app/built-in launcher removals.
- Proved native IP playback with ZDF, then generalized the native tuning path and physically confirmed 3sat picture/audio.
- Added the on-TV Channel Room account/category/channel management app, local proxy, native provider and persistent background refresh.
- Replaced a full-library import with selectable categories, preserving channel numbers and native editor fields.
- Added bounded streaming XMLTV import, staged atomic merge, current-channel short-EPG fallback and persistent Guide snapshots.
- Fixed category removals across SQL, IEPG shared caches, UTP tuning maps, native genre filters and the restored Guide QML model.
- Added Guide-only CRIU invalidation when UI code changes, plus a resident LS2 bridge to avoid Node 8 child-process failures.
- Added a fresh-install diagnostic/deployer, private per-TV launcher builder, recovery tooling, synthetic offline tests and real TV screenshots.

The final recorded live selection was 21 categories / 1,259 channels / 9,664 schedules. The public installer is new packaging of the working runtime and still needs a clean-install/uninstall validation on another physical TV; see [compatibility](docs/COMPATIBILITY.md).
