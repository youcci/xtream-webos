#!/usr/bin/env python3
"""Root-SSH deployment and private launcher packaging. Python 3.9+, standard library."""
import argparse
import base64
import gzip
import io
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import subprocess
import sys
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime"
REMOTE = "/var/lib/xtream-native"
STAGE = "/var/lib/xtream-native.install-tmp"
APP_ID = "io.github.youcci.xtreamwebos"
VERSION = "0.1.0"
QML = "/usr/palm/applications/com.webos.app.livemenu/qml"
RELATIVES = ("main.qml", "Pages/Page1/Components/SettingPopupFeed.qml",
             "Controllers/ChannelInterfaces/Interfaces.qml")
CHANNEL_DB = "/mnt/lg/cmn_data/iepg/db/channel.sql"
GUIDE_DB = "/tmp/epg/PBS_EPG_DB.db"


class TV:
    def __init__(self, host, key=None):
        if not host or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.:-]*", host):
            raise ValueError("Supply --host TV_IP or a root SSH config alias (without root@).")
        self.ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]
        if key:
            self.ssh += ["-i", str(Path(key).expanduser())]
        self.ssh += ["root@" + host]

    def run(self, command, data=None, timeout=45, check=True):
        result = subprocess.run(self.ssh + [command], input=data, capture_output=True, timeout=timeout)
        if check and result.returncode:
            # Do not echo command text: package operations can carry a private token.
            detail = result.stderr.decode("utf-8", "replace").strip()[-1000:]
            raise RuntimeError("TV command failed" + (": " + detail if detail else "."))
        return result

    def text(self, command, **kwargs):
        return self.run(command, **kwargs).stdout.decode("utf-8")

    def node(self, code, timeout=45):
        # Dropbear limits remote command length. Compress rather than piping a
        # script into Node 8: its child-process setup can fail with stdin pipes.
        packed = base64.b64encode(gzip.compress(code.encode())).decode("ascii")
        bootstrap = "eval(require('zlib').gunzipSync(Buffer.from('" + packed + "','base64')).toString('utf8'))"
        return json.loads(self.text("node -e " + shlex.quote(bootstrap), timeout=timeout))

    def luna(self, uri, payload, timeout=20):
        command = "luna-send -w {} -n 1 {} {} < /dev/zero".format(
            int((timeout-2)*1000), shlex.quote(uri), shlex.quote(json.dumps(payload)))
        value = json.loads(self.text(command, timeout=timeout))
        if value.get("returnValue") is False:
            raise RuntimeError("TV API rejected " + uri.rsplit("/", 1)[-1] + ".")
        return value

    def transaction(self, uri, payload, terminal_status, timeout=90):
        """Read actual terminal installer status, not just its first acknowledgement."""
        command = "luna-send -w 80000 -i {} {} < /dev/zero".format(
            shlex.quote(uri), shlex.quote(json.dumps(payload)))
        proc = subprocess.Popen(self.ssh + [command], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        decoder = json.JSONDecoder()
        buffer = ""
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                for selected, _ in selector.select(timeout=min(1, max(0, deadline-time.monotonic()))):
                    chunk = os.read(selected.fileobj.fileno(), 65536)
                    if not chunk:
                        raise RuntimeError("Installer ended before a terminal success status.")
                    buffer += chunk.decode("utf-8", "replace")
                    while buffer.strip():
                        buffer = buffer.lstrip()
                        try:
                            value, end = decoder.raw_decode(buffer)
                        except json.JSONDecodeError:
                            break
                        buffer = buffer[end:]
                        details = value.get("details")
                        status = value.get("statusValue", details.get("statusValue") if isinstance(details, dict) else None)
                        if value.get("returnValue") is False or (isinstance(status, int) and status < 0):
                            raise RuntimeError("The TV installer rejected the package. Check its compatibility and free space.")
                        if status == terminal_status:
                            return value
            raise RuntimeError("Timed out waiting for the TV installer's final status.")
        finally:
            selector.close()
            proc.terminate()
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()


def inspect_tv(tv):
    if tv.text("id -u").strip() != "0":
        raise RuntimeError("Root SSH is required. Developer Mode's prisoner shell is insufficient.")
    code = (RUNTIME / "prepare.js").read_text()
    template = json.loads((RUNTIME / "native-template.json").read_text())
    options = {"base": REMOTE, "template": template,
               "guideSchema": (RUNTIME / "guide-schema.sql").read_text()}
    code += "\nvar report=module.exports.inspect(" + json.dumps(options) + ");delete report.sources;"
    code += "report.node=process.version;report.webosService=fs.existsSync('/usr/lib/node_modules/webos-service');"
    code += "report.startupHooks=fs.existsSync('/var/lib/webosbrew/init.d');"
    code += "report.existingInstallation=fs.existsSync('/var/lib/xtream-native/settings.private.json');"
    code += "report.feedExecutable=fs.existsSync('/usr/sbin/pbs');console.log(JSON.stringify(report));"
    report = tv.node(code)
    dependencies = tv.text("for tool in node sqlite3 curl systemctl mount tar luna-send; do command -v \"$tool\" >/dev/null || echo \"$tool\"; done").split()
    report["missingCommands"] = dependencies
    try:
        info = tv.luna("luna://com.webos.service.tv.systemproperty/getSystemInfo",
                       {"keys": ["modelName", "firmwareVersion", "sdkVersion"]})
        report["tv"] = {key: info.get(key) for key in ("modelName", "firmwareVersion", "sdkVersion")}
    except RuntimeError:
        report["tv"] = {"modelName": None, "firmwareVersion": None, "sdkVersion": None}
    apps = tv.luna("luna://com.webos.applicationManager/listApps", {})
    report["developerModeInstalled"] = any("devmode" in a.get("id", "").lower() for a in apps.get("apps", []))
    return report


def validate_install(report, experimental):
    if report.get("missingCommands"):
        raise RuntimeError("Missing TV commands: " + ", ".join(report["missingCommands"]))
    for required in ("compatible", "webosService", "startupHooks", "feedExecutable"):
        if not report.get(required):
            raise RuntimeError("Missing required compatibility check: " + required)
    if report["developerModeInstalled"]:
        raise RuntimeError("Uninstall LG Developer Mode after rooting and before installing/rebooting. See docs/ROOTING.md.")
    if report["existingInstallation"] or report["qml"] != "anchors-match":
        raise RuntimeError("An existing manual/runtime installation was found. See docs/MIGRATION.md; it will not be overwritten.")
    info = report.get("tv", {})
    tested = info.get("modelName") == "OLED55G19LA" and info.get("firmwareVersion") == "03.53.45"
    if not tested and not experimental:
        raise RuntimeError("This model/firmware is not the validated TV. Read docs/COMPATIBILITY.md before using --experimental.")
    sdk = str(info.get("sdkVersion") or "")
    if sdk and not sdk.startswith("6."):
        raise RuntimeError("Only the webOS 6 native profile is currently supported.")


def runtime_tar():
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as archive:
        for file in sorted(RUNTIME.rglob("*")):
            if not file.is_file():
                continue
            relative = file.relative_to(RUNTIME)
            if any(part in ("originals", "patches", "backups") for part in relative.parts) or ".private." in file.name:
                raise RuntimeError("Refusing to package private/generated runtime files.")
            if file.suffix not in (".js", ".json", ".html", ".css", ".svg", ".png", ".sql", ".service", ".sh") and file.name not in ("pbs-disabled", "40-native-xtream", "55-disable-lg-channels", "60-native-xtream"):
                raise RuntimeError("Unexpected runtime file: " + str(relative))
            archive.add(file, arcname=str(relative), recursive=False)
    return data.getvalue()


def tar_gz(files):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as archive:
        for name, content in files.items():
            item = tarfile.TarInfo(name)
            item.size = len(content)
            item.mode = 0o644
            item.uid = item.gid = item.mtime = 0
            archive.addfile(item, io.BytesIO(content))
    return data.getvalue()


def ar_package(members):
    # macOS ar can produce an archive that webOS rejects. Emit the Debian ar
    # container explicitly; every header is 60 bytes, odd members are padded.
    result = bytearray(b"!<arch>\n")
    for name, content in members:
        header = "{:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`\n".format(name + "/", 0, 0, 0, "100644", len(content))
        assert len(header) == 60
        result.extend(header.encode("ascii"))
        result.extend(content)
        if len(content) % 2:
            result.extend(b"\n")
    return bytes(result)


def launcher_package(token):
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        raise ValueError("The device management token must be 64 lowercase hex characters.")
    target = "http://127.0.0.1:17651/app/#token=" + token + "&view=categories"
    html = ('<!doctype html><meta charset="utf-8"><title>Xtream TV</title>'
            '<script>location.replace(' + json.dumps(target) + ');</script>').encode()
    app = {"id": APP_ID, "version": VERSION, "vendor": "youcci", "type": "web",
           "main": "index.html", "title": "Xtream TV", "icon": "icon.png",
           "largeIcon": "icon.png", "visible": True, "resolution": "1920x1080"}
    prefix = "./usr/palm/applications/" + APP_ID + "/"
    files = {prefix + "appinfo.json": json.dumps(app).encode(), prefix + "index.html": html,
             prefix + "icon.png": (RUNTIME / "app/icon.png").read_bytes(),
             "./usr/palm/packages/" + APP_ID + "/packageinfo.json":
                 json.dumps({"id": APP_ID, "version": VERSION, "app": APP_ID}).encode()}
    control = ("Package: " + APP_ID + "\nVersion: " + VERSION + "\nSection: misc\n"
               "Priority: optional\nArchitecture: all\nMaintainer: youcci\n"
               "Description: Local launcher for Xtream webOS native channel management\n").encode()
    return ar_package([("debian-binary", b"2.0\n"),
                       ("control.tar.gz", tar_gz({"./control": control})),
                       ("data.tar.gz", tar_gz(files))])


def fetch_token(tv):
    value = json.loads(tv.text("cat " + REMOTE + "/settings.private.json"))
    return value["token"]


def write_private_package(tv, output=None):
    path = Path(output) if output else ROOT / "dist" / (APP_ID + "_" + VERSION + "_all.ipk")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Open with restrictive permissions before writing any token-bearing data.
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.chmod(path, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(launcher_package(fetch_token(tv)))
    return path


def install(tv, args):
    if not args.replace_lg_channels:
        raise RuntimeError("Installation replaces the stock IP feed. Pass --replace-lg-channels after reading the backup/restore instructions.")
    report = inspect_tv(tv)
    print(json.dumps(report, indent=2))
    validate_install(report, args.experimental)
    tv.run("test ! -e {0} && test ! -e {1} && test ! -e /var/lib/webosbrew/init.d/55-disable-lg-channels && test ! -e /var/lib/webosbrew/init.d/60-native-xtream".format(REMOTE, STAGE))
    tv.run("umask 077; mkdir -m 700 " + STAGE)
    tv.run("tar -xzf - -C " + STAGE, data=runtime_tar())
    # All compatibility checks and overlays are prepared before touching TV data.
    tv.run("node " + STAGE + "/prepare.js")
    backup = STAGE + "/backups"
    tv.run("set -e; mkdir -m 700 {b}; sqlite3 {db} {sql}; if test -f {guide}; then sqlite3 {guide} {gsql}; fi".format(
        b=backup, db=CHANNEL_DB, guide=GUIDE_DB,
        sql=shlex.quote(".backup '" + backup + "/channels-before.sqlite'"),
        gsql=shlex.quote(".backup '" + backup + "/guide-before.sqlite'")))
    # Preserve the stock feed's replies for diagnostics/recovery, never print them.
    state = {}
    for key, method in (("policy", "getCountryPolicy"), ("status", "getEpgStatus")):
        try:
            state[key] = tv.luna("luna://com.webos.service.pbsw/" + method, {})
        except RuntimeError:
            state[key] = {"unavailable": True}
    tv.run("cat > " + backup + "/original-provider-state.json", data=json.dumps(state).encode())
    tv.run("set -e; mv {stage} {remote}; chmod 700 {remote}/control.sh {remote}/hooks/* {remote}/pbs-disabled; touch {remote}/enabled; cp {remote}/hooks/40-native-xtream /var/lib/webosbrew/init.d/40-native-xtream; cp {remote}/hooks/55-disable-lg-channels /var/lib/webosbrew/init.d/55-disable-lg-channels; cp {remote}/hooks/60-native-xtream /var/lib/webosbrew/init.d/60-native-xtream; {remote}/control.sh start".format(stage=STAGE, remote=REMOTE), timeout=90)
    package = write_private_package(tv)
    tv.run("umask 077; cat > /tmp/xtream-webos-launcher.ipk", data=package.read_bytes())
    tv.transaction("luna://com.webos.appInstallService/dev/install",
                   {"id": "xtream-webos-install", "ipkUrl": "/tmp/xtream-webos-launcher.ipk", "subscribe": True}, 30)
    apps = tv.luna("luna://com.webos.applicationManager/listApps", {})
    if not any(a.get("id") == APP_ID for a in apps.get("apps", [])):
        raise RuntimeError("The launcher was not registered after installation.")
    print("Installed. Open Xtream TV → Account, Save & sync, then Categories → Apply selection.")
    print("Private launcher package (do not publish): " + str(package))


def uninstall(tv, restore):
    if not restore:
        raise RuntimeError("Use --restore-lg-channels to explicitly restore the backed-up LG IP list and original feed.")
    if tv.text("test -f " + REMOTE + "/backups/channels-before.sqlite; echo $?").strip() != "0":
        raise RuntimeError("The installer backup is missing. See docs/RECOVERY.md for manual-install recovery.")
    if tv.text("sqlite3 " + REMOTE + "/backups/channels-before.sqlite 'PRAGMA quick_check;'").strip() != "ok":
        raise RuntimeError("The channel backup failed its integrity check; no changes were made.")
    tv.run("set -e; rm -f {p}/enabled; {p}/control.sh stop; rm -f /var/lib/webosbrew/init.d/40-native-xtream /var/lib/webosbrew/init.d/55-disable-lg-channels /var/lib/webosbrew/init.d/60-native-xtream".format(p=REMOTE))
    cols = ",".join(json.loads((RUNTIME / "native-template.json").read_text()))
    sql = (".bail on\n.timeout 15000\nATTACH DATABASE '" + REMOTE + "/backups/channels-before.sqlite' AS saved;\n"
           "BEGIN IMMEDIATE; DELETE FROM ip WHERE substr(chan_code,1,7)='xtream_';\n"
           "INSERT OR REPLACE INTO ip(" + cols + ") SELECT " + cols + " FROM saved.ip WHERE chan_code IS NULL OR substr(chan_code,1,7)!='xtream_';\n"
           "DELETE FROM pbs_genre_base WHERE genre_type='S' AND reserved_1='XTREAM'; COMMIT;\n")
    tv.run("sqlite3 -batch -bail " + CHANNEL_DB, data=sql.encode())
    guide_sql = (".timeout 15000\nDELETE FROM PBS_BROADCAST_SCHEDULE WHERE substr(chan_code,1,7)='xtream_';\n"
                 "DELETE FROM PBS_BROADCAST_PROGRAM WHERE substr(contents_id,1,7)='xtream_';\n")
    tv.run("sqlite3 -batch -bail " + GUIDE_DB, data=guide_sql.encode())
    for relative in reversed(RELATIVES):
        target = QML + "/" + relative
        tv.run("if grep -q " + shlex.quote(" " + target + " ") + " /proc/mounts; then umount " + shlex.quote(target) + "; fi")
    tv.run("if grep -q ' /usr/sbin/pbs ' /proc/mounts; then umount /usr/sbin/pbs; fi; rm -f /tmp/checkpoint/com.webos.app.livemenu/pgid /mnt/lg/cmn_data/checkpoint/com.webos.app.livemenu/pgid /tmp/checkpoint/hash_check_com.webos.app.livemenu; for guide_pid in $(pidof com.webos.app.livemenu || true); do kill -TERM \"$guide_pid\" 2>/dev/null || true; done")
    # This activates the unmasked stock feed; current Guide entries can refill.
    tv.luna("luna://com.webos.service.pbsw/getCountryPolicy", {})
    print("Xtream stopped; original IP rows/feed restored. Remove Xtream TV from the Home app editor.")
    print("Private runtime/backups were retained under " + REMOTE + ". Root and optional debloat were left installed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.getenv("XTREAM_TV_HOST"), help="TV IP/DNS name or SSH config alias; root login")
    parser.add_argument("--key", default=os.getenv("XTREAM_TV_KEY"), help="Root SSH private key path; never copied into a package")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor", help="Read-only native schema/QML/dependency check")
    deploy = sub.add_parser("install", help="Fresh installation; refuses to overwrite a manual setup")
    deploy.add_argument("--replace-lg-channels", action="store_true")
    deploy.add_argument("--experimental", action="store_true", help="Other webOS 6 firmware, still requiring matching schema/anchors")
    package = sub.add_parser("package", help="Build a private per-TV launcher; no TV changes")
    package.add_argument("--output")
    sub.add_parser("status", help="Read local runtime status; credentials excluded")
    sub.add_parser("open", help="Open the installed Xtream TV manager")
    snap = sub.add_parser("screenshot", help="Capture compositor UI; hardware video is excluded")
    snap.add_argument("--output", required=True)
    remove = sub.add_parser("uninstall", help="Remove native integration and restore the LG IP feed")
    remove.add_argument("--restore-lg-channels", action="store_true")
    args = parser.parse_args()
    try:
        tv = TV(args.host, args.key)
        if args.command == "doctor":
            print(json.dumps(inspect_tv(tv), indent=2))
        elif args.command == "install":
            install(tv, args)
        elif args.command == "package":
            print("Private per-device package; do not publish: " + str(write_private_package(tv, args.output)))
        elif args.command == "status":
            print(json.dumps(json.loads(tv.text("curl -fs http://127.0.0.1:17651/status")), indent=2))
        elif args.command == "open":
            tv.luna("luna://com.webos.applicationManager/launch", {"id": APP_ID})
            print("Opened Xtream TV.")
        elif args.command == "screenshot":
            tv.luna("luna://com.webos.surfacemanager/captureCompositorOutput", {"output": "/tmp/xtream-webos-shot.png", "format": "PNG"})
            Path(args.output).write_bytes(tv.run("cat /tmp/xtream-webos-shot.png").stdout)
            print("Saved compositor UI: " + args.output)
        elif args.command == "uninstall":
            uninstall(tv, args.restore_lg_channels)
    except (ValueError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as error:
        print("Error: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
