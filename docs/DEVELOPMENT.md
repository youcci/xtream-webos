# Development, packaging and contribution

## Layout

| Location | Responsibility |
| --- | --- |
| `runtime/app/` | Dependency-free TV UI, keyboard/D-pad navigation and polling |
| `runtime/server.js` | Loopback HTTP APIs, assets and player telemetry |
| `runtime/lib/manager.js` | Settings, jobs, category selection and persistence |
| `runtime/lib/catalog.js`, `native-db.js` | Stable metadata assignments and native SQL transactions |
| `runtime/lib/epg.js` | Bounded streaming XMLTV parser/staging/merge and short-EPG fallback |
| `runtime/lib/proxy.js`, `client.js` | Provider calls and local HLS proxy |
| `runtime/provider.js` | PBS capability replies and resident LS2 IPC bridge |
| `runtime/player.html` | Dmost hardware video integration and telemetry |
| `runtime/lib/playback-watchdog.js` | Guarded recovery of a missing native player heartbeat |
| `runtime/lib/startup-resume.js` | Once-per-boot last-channel selection from LG's empty fallback |
| `runtime/lib/boot-player.js`, `xtream-native-boot.service` | Early Linux boot setup and bounded hidden-player readiness |
| `runtime/prepare.js` | Firmware-anchor/schema checks and private QML generation |
| `runtime/control.sh`, `hooks/` | Transient units, startup, bind mounts and checkpoint invalidation |
| `tools/xtream_webos.py` | Root-SSH diagnostic, deployment, private IPK builder, screenshot and restore |
| `debloat/` | Adapted upstream script, compatibility diff, preload hook, built-in logical-removal helper |
| `tests/` | Offline synthetic catalogue/database/XML/packaging checks |

The production JS targets **Node 8.12** and the UI targets Chromium 79. Do not add modern syntax/APIs without a compatibility plan. No npm packages, bundler or SDK are needed. Keep host tooling Python 3.9+ standard-library-only.

## Run checks

Requires a host Node.js and SQLite executable at `/usr/bin/sqlite3` (the tested macOS and CI Ubuntu environments both provide it).

```sh
node tests/epg.test.js
node tests/native.test.js
node tests/watchdog.test.js
node tests/resume.test.js
node tests/boot.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
python3 tools/check_public.py
git diff --check
```

The EPG suite covers time offsets/DST, chunked Unicode and CDATA, invalid/entity-expanding XML, limits/backpressure, multi-channel mapping, atomic failure/cancel behavior, short-EPG fallback and gzip/large imports. Native tests use a **synthetic** schema, exercise 21,001-row imports, stable numbering, category filtering, SQL quoting, retained editor fields, empty removal and QML anchor/cache guards. Python tests inspect the Debian ar/tar package structure, private-runtime boundaries and install gates. CI runs these without contacting a provider or TV.

Tests do not replace physical tuning, sound, native Guide lifecycle, HDMI transition, root persistence or fresh-install/uninstall validation. Do not run category-mutating tests on a user's live selection. The hardware video layer needs physical confirmation.

Playback recovery tests cover native ownership/foreground gates, RF/locked/foreign channels, healthy heartbeats, startup/transition grace, cooldown, in-flight heartbeat recovery, sanitized errors, overlapping checks, missing-app startup, selection changes, bounded launch readiness and page acknowledgement before native replay. Distinguish a missing page from a missing app when reproducing a failure. Do not induce a blank player on a live TV without accounting for the viewer; a real recovery test briefly interrupts video.

Startup-resume tests cover exclusive boot-runtime marker persistence/reset, service restarts, the boot deadline, native readiness, the two-second stability check without a fixed startup sleep, empty-fallback recognition, other apps/channels, changing history/catalogue, native-failure backoff, uncertain launch acknowledgements and decoded playback confirmation. A physical reboot test must avoid manual tuning so that it actually exercises automatic selection. Compare boot-relative `startupResume.timings` with the service's systemd monotonic start timestamp when measuring improvements.

Early-boot tests exercise bounded player inventory/URL readiness, transient failures, deadlines and absence of unsolicited app/channel launches. Python tests execute both boot hooks with temporary paths and a systemctl stub to verify the common nonblocking job, disabled-state behavior and legacy fallback. Physical validation must also monitor playback past any earlier observed WAM-exit window; an early first frame alone does not establish sustained startup success.

Parallel-start tests verify bridge readiness retry/deadline behavior; native tests verify that boot retains the selected catalogue while deferring and caching the complete provider library. Test a pending transaction as a recovery operation rather than assuming lazy loading may discard its full metadata.

## Packaging

`install` creates a launcher after the manager has generated a random per-TV token. To rebuild for an installed TV:

```sh
python3 tools/xtream_webos.py --host TV_IP --key ~/.ssh/webos_tv package
```

Output goes to `dist/io.github.youcci.xtreamwebos_0.1.0_all.ipk`, mode 0600. It redirects to the TV-local manager with its token in a URL fragment. Python writes the Debian ar container explicitly, avoiding macOS `ar` variants rejected by webOS. The runtime itself is transferred separately over root SSH; installing the launcher alone cannot establish native integration.

**Never publish that IPK or `dist/`.** There is intentionally no universal token-bearing prebuilt app download. Public distribution is source plus a per-device builder. Never add a real account to a demo, fixture, script or screenshot.

## Local API

All management routes use `X-Xtream-Token` and accept only the local expected browser Origin when one is present. Responses suppress provider credentials in errors. Account form retrieval exposes the saved server/username and `passwordSet`, never the password.

| Method / path | Action |
| --- | --- |
| `GET /api/status` | Counts, sync/Guide jobs and player status |
| `GET /api/settings` | Account form without password, refresh intervals |
| `PUT /api/settings` | Validate/persist account and intervals |
| `POST /api/test-account` | Check candidate account |
| `POST /api/sync` | Download metadata and apply saved selection |
| `GET /api/category-selection` | All categories, saved IDs and imported count |
| `POST /api/category-selection` | Apply `{ "ids": ["CATEGORY_ID"] }` |
| `GET /api/categories` | Imported categories |
| `GET /api/channels` | Imported channel search/pagination |
| `POST /api/refresh-guide` | Start full Guide refresh |
| `POST /api/tune` | Watch channel by stream `id` |
| `POST /api/open-guide` | Tune a selected/current channel and launch native Guide |

Job starters return HTTP 202; poll status until completion. HTTP acceptance is not job completion. Playback/status/telemetry endpoints exist without management authentication on loopback for native Dmost; see [security](../SECURITY.md).

## Reporting problems

Include model, firmware, webOS version, diagnostic output, job phase and concise reproduction steps. Redact account URL/username, channel lists you do not want public and all tokens/keys. Never upload whole TV backups, LG QML/binaries or a generated launcher.

For another firmware, contribute a reviewed schema/QML profile and synthetic fixtures with device validation results. Do not weaken structural checks to make the installer proceed. Keep patch transformations small and fail closed on missing/duplicate anchors. Add validation of actual native cache/tuning behavior, rather than relying only on direct SQL row counts.
