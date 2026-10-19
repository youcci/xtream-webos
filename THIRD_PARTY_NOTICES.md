# Attribution and distribution boundaries

- `debloat/webos-debloat-webos6.sh` is an adapted snapshot of
  [lucataco's webos-debloat gist](https://gist.github.com/lucataco/7c303b443934008a9031a55cfca552ec).
  The upstream script declares `SPDX-License-Identifier: MIT`; that header is
  retained. The snapshot revision is `ecc48489e07ae7e51680651e84c3ed87de9d7d0a`.
  Its webOS 6 changes are recorded in `debloat/webos6-compatibility.patch`.
  The MIT permission and disclaimer are included in this repository's LICENSE.
- [SlopBro](https://github.com/throwaway96/slopbro) is AGPL-3.0-or-later. It is
  linked as a separate upstream rooting tool, **not copied or relicensed here**.
- [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) and
  [webOS Homebrew](https://www.webosbrew.org/) provide the rooted environment and
  startup-hook facility. Download their software from their own projects.
- The runtime uses the TV's existing `webos-service` module (Apache-2.0), Node.js,
  SQLite, LS2, native Guide, UTP and embedded Dmost player. Those dependencies and
  LG firmware are not bundled.
- The native table/field layouts and Luna method names in this project describe
  the tested interoperability profile. `prepare.js` makes small transformations
  to the owner's own QML files **on their TV**. Full LG QML, native binaries,
  decompiler exports, firmware images, database dumps and checkpoint images are
  deliberately not redistributed.
- Screenshots in `docs/images/` show the author's physical TV and the original
  Channel Room interface. LG interface elements and programme/provider names
  belong to their respective owners. No video frames, credentials or subscription
  entitlement are supplied. This project is not affiliated with LG or webOSbrew.
