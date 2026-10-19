# Change log

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
