# Existing PoC and manual installations

The original development used `/var/lib/xtream-native-poc`, followed by a manually managed `/var/lib/xtream-native`, and a launcher ID `org.webosbrew.xtreamnative`. The public launcher is **`io.github.youcci.xtreamwebos`** to avoid suggesting it is an official webOSbrew app. Its interface remains Channel Room / Xtream TV.

The development TV keeps its working installation and saved selection. Publishing this repository does not reinstall its app, change its account or reapply category test selections.

## Why fresh install refuses to overwrite

Manual installations can already have mounted QML, different original backups, a masked PBS service, old native IDs/number assignments and token-bearing launcher packages. Copying the fresh runtime over them could lose recovery state or derive overlays from already modified files. `doctor` reports these conditions and `install` refuses them. There is no automatic in-place legacy upgrade in version 0.1.0.

## Before any deliberate migration

1. Copy the entire existing runtime, original backups, startup hooks and relevant native SQLite snapshots to private off-TV storage. Use SQLite `.backup` for live databases, not a raw copy during writes.
2. Record current mounts, old Dmost URL, services and root startup method. Keep all account/token/SSH data private.
3. Preserve `settings.private.json`, `library.private.json`, `catalog.private.json`, `history.json` and Guide cache. The library carries stable assignments; losing it can renumber channels.
4. Do not modify saved settings while someone is editing the TV app. Apply/recover their actual draft first.
5. Restore the original native integration using that installation's own backups and reviewed procedure, or implement a targeted upgrade against its exact layout. Do not use the public uninstaller if its expected fresh-install backup is absent.
6. For a genuinely clean reinstall, confirm the old hooks/processes/mounts are gone, original QML is visible, stock state is restored, and the old runtime is privately archived outside the fresh install path. Then rerun `doctor`.

Copying only a launcher never migrates the backend. Copying only QML never refreshes IEPG/UTP state. The full runtime, provider, native cache handling and overlays form one integration. Do not mix the historical PoC player with the full service.

The historical ZDF channel number 9990 was a PoC choice. It is not reserved by the public catalogue builder; a clean setup allocates from 1001. Existing assignment ledgers can retain older assignments when handled in a reviewed migration.
