# Security and private data

This integration runs with root privileges on a rooted TV. Its trust boundary includes the TV operating system, other privileged TV apps, your root SSH session and the provider. Matching schemas do not make arbitrary firmware modifications safe.

- The manager listens only on **127.0.0.1:17651**, not the LAN. Do not bind it to `0.0.0.0`, forward this port or expose SSH to the internet.
- Management APIs require a random 32-byte per-TV token and reject an unexpected browser Origin. The private installed launcher carries that token in a fragment. It is a convenience boundary, not isolation from root/privileged code on the TV.
- Native playback endpoints, status and telemetry are available on loopback without the management token. A process able to access that local context can potentially use the active streaming account. Other privileged apps/root can read the account directly.
- Provider credentials are stored **in plaintext** in root-readable private JSON, inside a 0700 runtime directory with 0600 private files. They are not encrypted at rest. They are needed for background refresh and playback without user interaction.
- Account details are kept out of native channel rows and player-facing URLs. Upstream credentials still travel to the provider in its Xtream API/stream requests; use HTTPS when supported. HTTP providers do not protect that traffic in transit.
- `native.sock` is 0600 inside the private runtime directory and allows a limited set of native actions through the resident LS2 connection.
- Generated IPKs, settings, SQLite/Guide backups, provider metadata, SSH keys, root pairing files, firmware originals and generated QML must remain private. `.gitignore` and `check_public.py` are guardrails, not a complete secret-detection guarantee.
- Review screenshots/logs before posting. The Account screen can show server/username; the Developer Mode screen can show a passphrase and local address. Hardware video is absent from compositor screenshots.

If a launcher token leaks, stop the services, privately replace the settings token with a fresh 64-character lowercase random hex token, restart the services and rebuild/reinstall the launcher. Old launchers then fail management authentication. If account credentials leak, change them with the provider as well. Never post a working credential to demonstrate a bug.

Report security problems without including live secrets. Use GitHub's private vulnerability reporting if enabled, or contact the repository owner privately before sharing exploit details. Do not upload proprietary firmware or complete device backups in reports.
