# Native integration architecture

This implementation was derived from observed behavior on the tested firmware. LG does not provide a supported public Xtream-to-native-Guide API. Paths and method contracts below describe this interoperability profile.

```mermaid
flowchart LR
  A[Xtream TV manager] -->|token-authenticated local API| B[Node manager]
  P[Xtream provider] -->|categories / channels / XMLTV| B
  B --> C[Native channel SQLite]
  B --> G[Native Guide SQLite]
  B -->|root-only Unix socket| L[Resident LS2 provider]
  L --> I[IEPG cache + UTP tuner map]
  C --> I
  I --> N[LG LiveTV + native Guide]
  N --> D[Native Dmost player]
  D --> H[Loopback HLS proxy]
  H --> P
```

## Runtime and persistence

`server.js` serves management APIs, UI, Dmost HTML and stream proxy on **127.0.0.1:17651**. `provider.js` owns the resident LS2 connection and a private Unix socket. Both run as root in `/var/lib/xtream-native` under transient systemd units copied to `/run/systemd/system` at startup.

| Path under `/var/lib/xtream-native` | Purpose |
| --- | --- |
| `settings.private.json` | Account, active account, refresh intervals, category IDs, management token |
| `library.private.json` | All provider live metadata and stable number assignments |
| `catalog.private.json` | Only selected/imported channels and categories |
| `catalog-transaction.private.json` | Recoverable pending channel commit |
| `history.json` | Last refreshes/current channel and schedule count |
| `guide-cache.sqlite` | Persistent backup of the otherwise volatile Guide DB |
| `originals/`, `patches/` | Private firmware originals and generated overlays |
| `firmware-profile.json` | Native compatibility profile / Guide executable hash |
| `backups/` | Pre-install SQLite snapshots and original provider replies |
| `native.sock` | 0600 IPC socket for allowed native actions |
| `enabled` | Startup marker |

The fresh-install directory is 0700; private JSON and socket permissions are 0600. No account is placed in native channel rows, browser query parameters or native player URLs. The per-TV launcher carries a management token in a fragment; see [security](../SECURITY.md).

## Channels and native categories

The manager downloads `get_live_categories` and `get_live_streams`, ignores decorative `#### ... ####` pseudo-channels, normalizes names, deduplicates IDs and maintains number assignments. A provider response with fewer than half the preceding library's usable channels is rejected to avoid replacing a good catalogue with an unexpectedly partial response.

The full library is filtered by selected category IDs before native import. New numbers start at 1001 and are retained in an assignment ledger even across removal/reappearance. Native IDs follow `11_3_NUMBER_65535_0_0_0`; source 11 / mode 7 and `com.webos.service.dmost` identify the tested native IP path. Owned rows use the `xtream_` code prefix. Category genres use codes 100–997, `genre_type='S'`, `reserved_1='XTREAM'`.

`native-db.js` streams SQL through stdin to SQLite, stages rows in a temporary table and commits them in one transaction. Owned channel and category rows are replaced; refreshes retain unrelated rows. Favourites, locks, skips and channel groups are copied from existing rows when refreshing the same account. **At installation/boot the separate feed-disabling hook removes non-Xtream IP rows** so the old stock feed cannot coexist with this provider. RF tables are untouched.

## Guide import

`epg.js` streams provider XMLTV through a bounded parser into staged SQLite data. It maps one EPG ID to multiple channel variants, handles explicit time offsets and converts UTC to the tested native timestamp representation. Imports target roughly a 36-hour window and the selected catalogue only.

Limits include 512 MB decompressed XML, 64 KB per programme block and 2 million staged rows. Parsing, cancellation, network and SQLite failures retain the previous successful bulk Guide. A failed full download can request short EPG for only the current stream. Programmes are deduplicated rather than copying long descriptions repeatedly for every variant.

Successful merges populate `PBS_BROADCAST_PROGRAM` and `PBS_BROADCAST_SCHEDULE` in `/tmp/epg/PBS_EPG_DB.db`. The manager snapshots a Guide database up to 160 MB into persistent storage; larger snapshots are skipped. Startup restores the cache when no owned schedules are present. Category removals prune schedules and unreferenced owned programmes before refreshing the selected Guide.

## Replacing the stock feed

The original `/usr/sbin/pbs` is bind-masked by an exit-only shell script, and any running original `pbs` process is stopped. Its firmware file stays intact. Our Node provider registers `com.webos.service.pbsw` and supplies the tested capability/status/channel replies. It never downloads LG's channel feed.

The native IEPG cache listens to country-policy subscription updates. Republishing the **unchanged** policy makes it rebuild the simplified channel cache from SQL. The manager then waits for the expected native IDs and toggles UTP's channel sort mode, restoring the original value after 750 ms, to reload the live tuner map.

**Do not emit a provider `changed:true` notification:** on this firmware it selects LG's DB8 provider-import path and can replace directly imported SQL data. Do not restart UTP to refresh a channel list; doing so broke LiveTV bindings during development.

The HTTP manager uses the resident provider's root-only Unix socket for LS2 requests. Repeated child-process `luna-send` calls from the Node 8 HTTP server could abort; this avoids that path. CLI Luna calls retain stdin using `< /dev/zero` because EOF caused silent failures on this firmware.

## Three QML overlays and the stale-cache fix

`prepare.js` generates small changes to the owner's own files:

1. `Pages/Page1/Components/SettingPopupFeed.qml`: expose native genre filtering when Xtream genre codes exist, including outside the stock USA/Korea country condition.
2. `Controllers/ChannelInterfaces/Interfaces.qml`: use the same genre condition and add a bounded refresh timer. It reloads genres and asks for channels when resumed/ready. It does not wait for page readiness before issuing the initial query.
3. `main.qml`: synchronously mark the channel list dirty through `refreshXtreamView()` **before** `registerApp()` on launch, so a restored Guide cannot reuse an old shared list after category removal.

LG can restore its Guide from a CRIU checkpoint without rereading QML. When overlay/executable hashes change, `control.sh` invalidates **only the Guide app's** checkpoint metadata and terminates only that app. The next launch loads the overlays and recreates the snapshot. Other app checkpoints and native TV services are left alone. Full LG QML and binaries are not distributed in this repository.

## Playback and input switching

Native tuning invokes the Dmost page with the selected native channel ID. `player.html` resolves the ID locally, opens a credential-free loopback stream URL and reports decoded dimensions/time/readiness. `proxy.js` requests provider HLS using the active account and rewrites playlist resources through local endpoints. Playback suspends when native ownership/input focus is lost, including HDMI switches, and resumes when LiveTV regains it.

There is no transcoder or external relay. TV codec/transport limits and provider availability still determine whether a particular channel works. The compositor screenshot API omits the hardware video plane; use physical picture/audio confirmation in addition to telemetry.

## Missing-player recovery

A later failure left all channels black even though the provider, catalogue, Guide and native channel selection still worked. Player telemetry had stopped for hours. Reapplying the local Dmost URL restored the current channel, with picture/audio confirmed on the TV. The exact native lifecycle event that dropped the page was not captured.

`playback-watchdog.js` checks every 10 seconds after a 30-second startup grace. If no player heartbeat has arrived for 15 seconds, it uses the resident LS2 bridge to check the foreground app and current native channel. It reloads the local player only for foreground LiveTV with a known imported channel and an unlocked/non-stopped native state. A fresh heartbeat during the checks cancels recovery. Attempts are limited to once per minute; healthy playback and other apps do not trigger reloads.

The bridge additionally permits `getForegroundAppInfo` and Dmost `getChannel`. No tuner restart, channel import, account change or application launch is involved. Status exposes sanitized `playbackRecovery` counters and the last recovery time. This handles a missing player page; fresh telemetry reporting an upstream/decoder error remains a separate playback problem.
