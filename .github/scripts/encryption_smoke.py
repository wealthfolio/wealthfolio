"""Exercise a built Docker image or extracted server release in disposable containers."""

import argparse
import base64
import http.client
import http.cookiejar
import json
import pathlib
import subprocess
import time
import tempfile
import urllib.error
import urllib.request
import uuid


def make_request(origin):
    # Export tickets belong to the browser session that created them.
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )

    def request(path, data=None, method=None, *, content_type="application/json",
                timeout=3, expected=200):
        req = urllib.request.Request(
            origin + path,
            data=data if isinstance(data, bytes) or data is None else json.dumps(data).encode(),
            headers={"Content-Type": content_type, "X-Wealthfolio-Backup": "1"},
            method=method or ("GET" if data is None else "PUT"),
        )
        with opener.open(req, timeout=timeout) as response:
            assert response.status == expected, (path, response.status)
            return response.read()

    return request


def portable_export(request, encrypted):
    """A small shipped-artifact check; large/fault tests belong in the storage suite."""
    started = time.monotonic()
    root = "/api/v1/utilities/database"
    password = "smoke portable backup password"
    snapshot = json.loads(request(root + "/backup", method="POST"))
    exported = json.loads(request(
        root + f"/backups/{snapshot['filename']}/export",
        {"password": password, "unencrypted": False}, method="POST", timeout=60,
    ))
    content = request(root + f"/exports/{exported['id']}", timeout=60)
    assert content.startswith(b"WFOLIOBACKUP\0\0\0\x01"), "Wrong portable backup format"
    assert len(content) > 16, "Empty portable backup"
    # A changed live value proves restoration uses the inspected snapshot.
    request("/api/v1/settings", {"theme": "light"})
    print(
        f"PASS portable protected export: encrypted={encrypted}, "
        f"elapsed={time.monotonic() - started:.2f}s", flush=True,
    )
    return content


def docker(*args, check=True, input=None):
    result = subprocess.run(
        ["docker", *args], input=input, check=False, capture_output=True, text=True, timeout=120
    )
    if check and result.returncode:
        raise RuntimeError(f"Docker command failed: {result.stdout}\n{result.stderr}")
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--image")
    target.add_argument("--package", type=pathlib.Path)
    args = parser.parse_args()
    name = "wf-encryption-smoke-" + uuid.uuid4().hex[:12]
    volume = name + "-data"
    key = base64.b64encode(b"a" * 32).decode()
    image = args.image or name + "-runtime"
    binary = "wealthfolio-server" if args.image else "/opt/wealthfolio/wealthfolio-server"
    mounts = [] if args.image else [
        "--platform", "linux/amd64",
        "--mount", f"type=bind,src={args.package.resolve()},dst=/opt/wealthfolio,readonly"
    ]
    static = "/app/dist" if args.image else "/opt/wealthfolio/dist"

    def command(encrypted, secret=key):
        return [
            "--name", name, "-v", f"{volume}:/data", *mounts,
            "-e", f"WF_SECRET_KEY={secret}",
            "-e", f"WF_DB_REQUIRE_ENCRYPTION={int(encrypted)}",
            "-e", "WF_DB_PATH=/data/wealthfolio.db",
            "-e", f"WF_STATIC_DIR={static}",
            "-e", "WF_AUTH_REQUIRED=false",
            "-e", "WF_LISTEN_ADDR=0.0.0.0:8088",
        ]

    def remove():
        docker("rm", "-f", name, check=False)

    def boot(encrypted, seed=False, wrong_key=False):
        secret = base64.b64encode(b"b" * 32).decode() if wrong_key else key
        docker("run", "-d", *command(encrypted, secret), "-p", "127.0.0.1::8088", image, binary)
        try:
            port = json.loads(docker("inspect", name))[0]["NetworkSettings"]["Ports"]["8088/tcp"][0]["HostPort"]
            request = make_request(f"http://127.0.0.1:{port}")

            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                if docker("inspect", "--format", "{{.State.Running}}", name) != "true":
                    raise RuntimeError("Server exited before becoming healthy")
                try:
                    request("/api/v1/healthz")
                    break
                except (OSError, urllib.error.URLError, http.client.HTTPException):
                    time.sleep(0.5)
            else:
                raise RuntimeError("Server health timeout")
            if wrong_key:
                # Profiles open lazily: health can succeed before the database is read.
                try:
                    request("/api/v1/settings")
                except urllib.error.HTTPError as error:
                    with error:
                        assert error.code == 423, ("Wrong-key response", error.code)
                        assert b"key did not open it" in error.read(), "Expected database key rejection"
                    print("PASS wrong key rejected on profile access", flush=True)
                    return
                raise AssertionError("Wrong key unexpectedly allowed database access")
            assert b"<html" in request("/").lower(), "Packaged frontend missing"
            status = json.loads(request("/api/v1/utilities/database/encryption"))
            assert status["enabled"] == encrypted, status
            if seed:
                request("/api/v1/settings", {"theme": "dark"})
            assert json.loads(request("/api/v1/settings"))["theme"] == "dark", "Data lost"
            if seed or not encrypted:
                backup = json.loads(request("/api/v1/utilities/database/backup", method="POST"))
                content = request(f"/api/v1/utilities/database/backups/{backup['filename']}/download")
                assert len(content) > 16, "Empty database backup"
                assert content.startswith(b"SQLite format 3\0") != encrypted, "Wrong backup encryption"
                return portable_export(request, encrypted)
            print(f"PASS startup, frontend, persistence: encrypted={encrypted}", flush=True)
        except Exception:
            logs = subprocess.run(["docker", "logs", name], capture_output=True, text=True, timeout=10)
            print(logs.stdout + logs.stderr, flush=True)
            raise
        finally:
            docker("stop", "-t", "5", name, check=False)
            remove()

    def convert(operation):
        try:
            docker("run", "--rm", *command(operation == "decrypt"), image, binary, "db", operation)
            print(f"PASS offline {operation}", flush=True)
        finally:
            remove()

    def restore(content, encrypted):
        # boot() has stopped the service. Reuse its volume, identity and policy.
        with tempfile.TemporaryDirectory(prefix="wf-backup-smoke-") as scratch:
            backup = pathlib.Path(scratch) / "backup.wfbackup"
            backup.write_bytes(content)
            # The container user must be able to traverse this read-only mount.
            pathlib.Path(scratch).chmod(0o755)
            backup.chmod(0o644)
            try:
                docker(
                    "run", "--rm", "-i", *command(encrypted),
                    "--mount", f"type=bind,src={scratch},dst=/backup,readonly",
                    image, binary, "db", "restore", "/backup/backup.wfbackup",
                    "--password-stdin", "--yes", input="smoke portable backup password",
                )
                print(f"PASS offline portable restore: encrypted={encrypted}", flush=True)
            finally:
                remove()

    docker("volume", "create", volume)
    try:
        if args.package:
            # Model a normal Debian installation, including the CA trust store used by HTTPS.
            # This only prepares the runtime; the supplied server is never recompiled.
            docker("build", "--platform", "linux/amd64", "-t", image, "-", input=(
                "FROM debian:13-slim\n"
                "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates "
                "&& rm -rf /var/lib/apt/lists/*\n"
            ))
        restore(boot(True, seed=True), True)
        boot(True)
        boot(True, wrong_key=True)
        convert("decrypt")
        restore(boot(False), False)
        convert("encrypt")
        boot(True)
    finally:
        remove()
        docker("volume", "rm", volume, check=False)
        if args.package:
            docker("image", "rm", image, check=False)


if __name__ == "__main__":
    main()
