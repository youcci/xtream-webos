# Change log

## Unreleased — cold-start player recovery (2026-10-19)

- Observed a recurring black screen after a real reboot: the hidden native player app was absent, no player telemetry had arrived, and its WAM methods timed out. The first recovery worker could not progress because it queried that absent player before starting it.
- Read actual selection through the native UTP binding/current-channel path. This works independently of the player and avoids the TV adapter's caller restrictions. Check foreground, import ownership and explicit unlocked state before starting the hidden player, loading the page and replaying the still-selected channel.
- Handle partial startup with fresh but inactive telemetry and an uninitialized native channel. Add bounded launch readiness, selection-change guards and stage-specific diagnostics. No historical/default channel fallback is used.
- Wait for the page's actual `app_ready` acknowledgement before replay. LiveTV's duplicate UI channel selection was a no-op, so use UTP's existing binding and `changeChannel` with `update:true`. A live LS2 trace confirmed that this emits the native Dmost `setChannel` for the same selected channel.
- Expand the playback regression suite from seven to fifteen cases, including cold startup, RF/locked exclusions, partial startup, user selection changes, failed launch readiness and missing page acknowledgement.
- Verified the missing-app path on the TV by closing the real hidden player app. Independent selection reads continued working while it was absent; automatic recovery started it once, reloaded once and performed one native replay, restoring the same channel at 720p after 26.9 seconds. This reproduces the missing-app condition; it is not a claim that another complete TV reboot was tested.

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
