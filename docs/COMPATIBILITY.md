# Compatibility and verification

| Component | Verified development environment |
| --- | --- |
| TV | LG OLED55G19LA |
| Firmware / webOS | 03.53.45 / 6.5.3 |
| Root environment | SlopBro revision recorded in [rooting](ROOTING.md); Homebrew Channel 0.7.3 |
| TV JavaScript | Node.js 8.12.0; Chromium 79 |
| Native IP database | `/mnt/lg/cmn_data/iepg/db/channel.sql`, 116-column `ip` table |
| Native Guide | `/tmp/epg/PBS_EPG_DB.db`, two PBS programme/schedule tables |
| Playback | Native Dmost hardware player with local HLS proxy |
| Last selected lineup | 21 categories / 1,259 channels / 9,664 schedules |

## Evidence and its limits

The runtime, manager UI, category selection/removal, native Guide refresh, background Guide import, HDMI transitions and persistence across real reboots were exercised on the development TV. ZDF picture and 3sat picture/sound were confirmed by its owner; 3sat reported 1080p. ARTE 720p and KiKA 1080p reported decoded playback with advancing time. Upstream failures also occurred, including HTTP 502 for one stream.

The category-removal regression was verified against the native Guide's actual shared channel list: **1,259** rows replaced a stale **1,342**-row model. The native genre map retained the 21 selected provider categories plus 13 stock entries, with the two removed generic 4K categories absent. Numbers and counts describe that account at that time, not bundled content.

The public installer/uninstaller and launcher builder were produced from that working setup. The installer diagnostic was run successfully against the live TV, and its three patch transformations matched privately retained originals from the tested firmware. Packaging and database behavior have offline tests. **A clean install/uninstall round trip using these new tools has not been performed on another physical TV.** The development TV keeps its existing working installation.

## What the checks enforce

- Root SSH, required TV module, startup-hook directory and original feed executable.
- Exact native IP column set and required genre fields.
- Existing Guide table column order where those tables exist.
- No competing provider occupying native genre codes 100–997.
- Unique expected QML anchors, refusing unknown or already manually patched files.
- No installed LG Developer Mode app or existing runtime on a fresh install.
- The known model/firmware by default; `--experimental` permits another webOS 6 device only after the same structural checks.
- Boot-time native IP schema and Guide executable hash checks before applying the profile.

These are failure guards, not a claim that matching column names imply full semantic compatibility. Root paths, permissions, LS2 behavior, available codecs, systemd, native method contracts and QML lifecycle behavior may differ on other firmware. Firmware updates require a new compatibility review; do not assume overlays remain compatible merely because root survives.

## Unsupported or unverified

Other webOS major versions, other models/regions, coexistence with another native IP provider, full-library imports at tens of thousands of channels, DRM, transcoding, VOD/series/catch-up/recording and external-input video capture are not supported or validated by this release. Only bring accounts/content you are entitled to access. No credentials or test subscription are distributed.
