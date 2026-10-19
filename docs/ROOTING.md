# Rooting and root SSH

This project needs persistent **root**, not just LG Developer Mode access. Rooting is firmware-specific; check the exact model and software version in the TV's Settings before following a method.

## 1. Choose a compatible method

Read the current [webOS Homebrew rooting guide](https://www.webosbrew.org/rooting/) and search [Can I Root My TV?](https://cani.rootmy.tv/). Those projects track newer firmware and available methods. Do not downgrade or run an older exploit just because it appears in a historical tutorial.

The development TV was OLED55G19LA / webOS 6.5.3 / firmware 03.53.45. It was rooted on 2026-10-18 using [SlopBro](https://github.com/throwaway96/slopbro), revision `21023d56ca424607bb03d2939609cc658c655fc7`, installing Homebrew Channel 0.7.3. This records the successful route; verify the upstream compatibility guidance for your TV first.

## 2. Run the tested route, if applicable

Use a computer and TV on the same trusted LAN. Temporarily allow the computer's local HTTP server through its firewall. `COMPUTER_LAN_IP` is the computer's LAN address reachable by the TV; `TV_IP` is the TV's address. Replace both placeholders.

```sh
git clone https://github.com/throwaway96/slopbro.git
cd slopbro
git checkout 21023d56ca424607bb03d2939609cc658c655fc7
python3 slopbro.py --help
python3 slopbro.py --webos-version 6 --local-ip COMPUTER_LAN_IP TV_IP
```

Accept the pairing prompt **on the TV** and follow the tool's status messages. The upstream README explains HTTP reachability tests and troubleshooting. Use its current instructions if the pinned revision no longer applies. SlopBro is a separate AGPL project; it is not bundled here.

## 3. Remove Developer Mode before rebooting

Once root/Homebrew Channel is installed, **uninstall the LG Developer Mode app before the first post-root reboot**. In Home's app editor, select Developer Mode and remove it. Turning its switch off is not the same as uninstalling it. Reinstalling it can interfere with the rooted environment; follow the [Homebrew rooting guidance](https://www.webosbrew.org/rooting/) and [upstream notes](https://gist.github.com/throwaway96/e811b0f7cc2a705a5a476a8dfa45e09f).

This timing refers to the reboot **after rooting**. If you use a different route that initially needs Developer Mode and a reboot to enable it, follow that route's prerequisites first.

Open Homebrew Channel, check root status and enable its startup-script facility. Enable SSH using its documented settings. Then perform a real reboot using Homebrew Channel's reboot action and verify that root/Homebrew still works and Developer Mode is absent. Ordinary remote power-off may only suspend the TV.

## 4. Establish private root SSH

Use the SSH authentication supported by your rooted setup. The Developer Mode key described in the linked guide is for the developer/prisoner connection; it is not interchangeable with a root key.

For a fresh dedicated key on the computer:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/webos_tv -C xtream-webos
```

Install its **public** key in root's `~/.ssh/authorized_keys` through your existing trusted root session, with directory permissions `700` and file permissions `600`. Keep the private key on the computer. Verify the SSH host fingerprint through your trusted initial connection; the deployment tool uses normal OpenSSH host-key checking and will not bypass it.

```sh
ssh -i ~/.ssh/webos_tv root@TV_IP 'id -u; node --version; command -v sqlite3'
```

`id -u` must report `0`. Ensure the key works in batch mode before disabling any temporary password login. Disable unused telnet through Homebrew Channel. Keep root SSH available for recovery; do not expose it to the internet.

## 5. Proceed with the native integration

Return to [installation](INSTALL.md). Rooting success alone does not mean that this project's native database/QML profile fits your TV. The read-only `doctor` command checks those separately.
