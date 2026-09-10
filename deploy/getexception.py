#!/usr/bin/env python3
"""Verified release installation. Requires Python 3.9+, Docker Compose and gh."""

import argparse
import contextlib
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request


REPOSITORY = "GetException/GetException"
WORKFLOW = REPOSITORY + "/.github/workflows/release.yml"
FILES = {"compose.yaml", "Caddyfile", "init-db.sh", "getexception.py", ".env.example", "release.json"}
SERVICES = ["web", "ingest", "worker-events", "worker-retention", "worker-mail"]
SECRET_KEYS = ["POSTGRES_PASSWORD", "MIGRATE_PASSWORD", "WEB_PASSWORD", "INGEST_PASSWORD",
               "WORKER_PASSWORD", "MAIL_PASSWORD", "BACKUP_PASSWORD", "BETTER_AUTH_SECRET",
               "TOTP_ENCRYPTION_KEY", "AUTH_RATE_KEY", "MAIL_ENCRYPTION_KEY"]
SHA = re.compile(r"^[a-f0-9]{40}$")


class Failure(Exception):
    pass


def run(args, *, env=None, stdout=subprocess.PIPE, timeout=600):
    try:
        result = subprocess.run(args, check=False, env=env, stdout=stdout,
                                stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Failure("Command unavailable or timed out: " + args[0]) from exc

    if result.returncode:
        # Tool output can contain resolved Compose secrets; never echo it.
        raise Failure("Command failed: " + args[0] + ". Inspect the service locally.")

    return result.stdout.decode().strip() if result.stdout else ""


def atomic_write(path, content, mode=0o600):
    path = Path(path)
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=".write-")

    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_json(path, value):
    atomic_write(path, json.dumps(value, indent=2) + "\n")


def read_env(path):
    values = {}

    for line in Path(path).read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z_]+", key):
            raise Failure("Invalid configuration key; keep the generated KEY=\"value\" format.")
        try:
            values[key] = json.loads(value).replace("$$", "$")
        except (ValueError, AttributeError) as exc:
            raise Failure("Invalid configuration value; use JSON double quotes.") from exc

    return values


def env_text(values):
    if any(any(ord(char) < 32 for char in value) for value in values.values()):
        raise Failure("Configuration values must not contain control characters.")

    return "".join(key + "=" + json.dumps(value.replace("$", "$$"), ensure_ascii=False) + "\n"
                   for key, value in values.items())


def domain(value):
    if (len(value) > 253 or "." not in value or value.endswith((".localhost", ".test"))
            or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part)
                       for part in value.split("."))):
        raise Failure("Use a public DNS hostname without protocol or port.")
    return value


def configure(root, options):
    path = root / "runtime/.env"
    if path.exists():
        os.chmod(path, 0o600)
        return read_env(path)

    dashboard = domain(options.dashboard_host or os.environ.get("DASHBOARD_HOST", ""))
    ingest = domain(options.ingest_host or os.environ.get("INGEST_HOST", ""))
    if dashboard == ingest:
        raise Failure("Dashboard and ingest require different hostnames.")

    values = {key: os.environ.get(key) or secrets.token_hex(32) for key in SECRET_KEYS}
    if len(set(values.values())) != len(values) or any(
            not re.fullmatch(r"[a-f0-9]{64}", value) for value in values.values()):
        raise Failure("Supply separate 32-byte hex secrets, or leave them unset to generate them.")

    values["ACME_EMAIL"] = os.environ.get("ACME_EMAIL", "")
    if values["ACME_EMAIL"] and not re.fullmatch(r"[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", values["ACME_EMAIL"]):
        raise Failure("ACME_EMAIL must be empty or a valid contact email.")
    values["MAIL_ENABLED"] = os.environ.get(
        "MAIL_ENABLED", "true" if os.environ.get("SMTP_HOST") or os.environ.get("SMTP_FROM") else "false")
    if values["MAIL_ENABLED"] not in ["true", "false"]:
        raise Failure("MAIL_ENABLED must be true or false.")
    for key in ["SMTP_HOST", "SMTP_FROM"]:
        values[key] = os.environ.get(key, "")
    for key, default in {"SMTP_PORT": "587", "SMTP_MODE": "starttls", "SMTP_USER": "",
                         "SMTP_PASSWORD": "", "WORKER_CONCURRENCY": "4"}.items():
        values[key] = os.environ.get(key, default)
    if values["MAIL_ENABLED"] == "true":
        if values["SMTP_MODE"] not in ["tls", "starttls"]:
            raise Failure("Production SMTP requires tls or starttls.")
        if not values["SMTP_PORT"].isdigit() or not 0 < int(values["SMTP_PORT"]) < 65536:
            raise Failure("Invalid SMTP port.")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", values["SMTP_FROM"]):
            raise Failure("Configure a valid SMTP_FROM to enable email delivery.")
        if not re.fullmatch(r"[a-zA-Z0-9.-]+", values["SMTP_HOST"]):
            raise Failure("Configure SMTP_HOST to enable email delivery.")
    if not values["WORKER_CONCURRENCY"].isdigit() or not 1 <= int(values["WORKER_CONCURRENCY"]) <= 16:
        raise Failure("WORKER_CONCURRENCY must be between 1 and 16.")

    token_path = root / "runtime/setup-token"
    token = token_path.read_text().strip() if token_path.exists() else secrets.token_hex(32)
    values.update(DASHBOARD_HOST=dashboard, INGEST_HOST=ingest,
                  SETUP_TOKEN_HASH=hashlib.sha256(token.encode()).hexdigest())
    atomic_write(token_path, token + "\n")
    atomic_write(path, env_text(values))
    return values


def metadata(directory, expected=None):
    value = json.loads((directory / "release.json").read_text())
    sha = value.get("sha", "")
    if not SHA.fullmatch(sha) or (expected and sha != expected) or value.get("repository") != REPOSITORY:
        raise Failure("Release identity does not match the requested commit.")
    if not isinstance(value.get("schemaVersion"), int) or not isinstance(value.get("rollbackFromSchemaVersions"), list):
        raise Failure("Missing migration compatibility metadata.")
    images = value.get("images", {})
    if set(images) != {"web", "ingest", "worker", "mail", "migrate"}:
        raise Failure("Release is missing runtime images.")
    for name, reference in images.items():
        if not re.fullmatch(r"ghcr\.io/getexception/getexception-" + name + r"@sha256:[a-f0-9]{64}", reference):
            raise Failure("Release images must use the expected GHCR repository and digest.")
    return value


def extract_archive(archive, destination):
    # Bound decompression BEFORE parsing tar headers (including PAX/long-name extensions).
    with gzip.open(archive, "rb") as stream:
        expanded = stream.read(12_030_721)
    if len(expanded) > 12_030_720:
        raise Failure("Expanded release archive exceeds the size limit.")
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as bundle:
        members = bundle.getmembers()
        if {entry.name for entry in members} != FILES or len(members) != len(FILES):
            raise Failure("Unexpected or duplicate paths in the release archive.")
        if any(not entry.isfile() or entry.size > 2_000_000 or entry.size < 0 for entry in members):
            raise Failure("Links, special files and oversized files are forbidden in releases.")
        for entry in members:
            source = bundle.extractfile(entry)
            if source is None:
                raise Failure("Unreadable archive member.")
            with source, (destination / entry.name).open("xb") as target:
                shutil.copyfileobj(source, target)
            # Templates contain no secrets; PostgreSQL's unprivileged entrypoint must read init-db.sh.
            os.chmod(destination / entry.name, 0o644)


def download(url, path):
    if urllib.parse.urlparse(url).scheme != "https":
        raise Failure("Release downloads require HTTPS.")
    request = urllib.request.Request(url, headers={"User-Agent": "GetException-installer"})
    with urllib.request.urlopen(request, timeout=60) as response, path.open("xb") as target:
        if urllib.parse.urlparse(response.url).scheme != "https":
            raise Failure("Refusing an insecure download redirect.")
        remaining = 12_000_000
        while True:
            chunk = response.read(min(65536, remaining + 1))
            if not chunk:
                break
            remaining -= len(chunk)
            if remaining < 0:
                raise Failure("Release download exceeds the size limit.")
            target.write(chunk)


def fetch_release(root, sha, archive_url=None, *, attestation_bundle=None, trusted_root=None):
    if not SHA.fullmatch(sha):
        raise Failure("--release requires the full 40-character Git commit SHA.")
    if bool(attestation_bundle) != bool(trusted_root):
        raise Failure("Offline verification requires both --attestation-bundle and --trusted-root.")
    verification = (["--bundle", str(Path(attestation_bundle).resolve()),
                     "--custom-trusted-root", str(Path(trusted_root).resolve())] if attestation_bundle else [])
    base = "https://github.com/" + REPOSITORY + "/releases/download/deploy-" + sha + "/"
    url = archive_url or base + "getexception.tar.gz"

    with tempfile.TemporaryDirectory(prefix="getexception-download-") as temporary:
        temporary = Path(temporary)
        archive = temporary / "getexception.tar.gz"
        checksum = temporary / "getexception.tar.gz.sha256"
        download(url, archive)
        download(url + ".sha256", checksum)
        expected = checksum.read_text().split()
        if len(expected) != 2 or expected[1] != archive.name or expected[0] != hashlib.sha256(archive.read_bytes()).hexdigest():
            raise Failure("Release checksum verification failed.")
        run(["gh", "attestation", "verify", str(archive), "--repo", REPOSITORY,
             "--signer-workflow", WORKFLOW, "--source-ref", "refs/heads/stable",
             "--source-digest", sha, *verification], timeout=120)
        unpacked = temporary / "bundle"
        unpacked.mkdir()
        extract_archive(archive, unpacked)
        metadata(unpacked, sha)
        destination = root / "releases" / sha
        if destination.exists():
            if any((destination / name).read_bytes() != (unpacked / name).read_bytes() for name in FILES):
                raise Failure("An existing immutable release differs from the published artifact.")
        else:
            with tempfile.TemporaryDirectory(dir=root / "releases", prefix=".staging-") as staging:
                staged = Path(staging) / "bundle"
                shutil.copytree(unpacked, staged)
                os.replace(staged, destination)
        return destination


def docker_environment():
    # Ambient variables must not override the installation's persisted secrets.
    allowed = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG",
               "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "SSH_AUTH_SOCK"]
    return {key: os.environ[key] for key in allowed if key in os.environ}


class Installation:
    def __init__(self, root):
        self.root = root
        self.runtime = root / "runtime"
        self.pending = self.runtime / "pending.json"

    def current(self):
        link = self.root / "current"
        if not link.exists():
            return None
        target = link.resolve()
        if target.parent != self.root / "releases":
            raise Failure("Invalid current release pointer.")
        return target

    def compose(self, release, *args, stdout=subprocess.PIPE):
        info = metadata(release)
        image_file = self.runtime / "images.env"
        atomic_write(image_file, env_text({key.upper() + "_IMAGE": value for key, value in info["images"].items()}))
        return run(["docker", "compose", "--project-name", "getexception", "--project-directory", str(release),
                    "--env-file", str(self.runtime / ".env"), "--env-file", str(image_file),
                    "-f", str(release / "compose.yaml"), *args], env=docker_environment(), stdout=stdout)

    def switch(self, release):
        temporary = self.root / ".current-next"
        temporary.unlink(missing_ok=True)
        temporary.symlink_to("releases/" + release.name)
        os.replace(temporary, self.root / "current")

    def backup(self, release):
        directory = self.runtime / "backups"
        directory.mkdir(mode=0o700, exist_ok=True)
        target = directory / (time.strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(4) + ".dump")
        with target.open("xb") as stream:
            self.compose(release, "exec", "-T", "postgres", "sh", "-c",
                         'PGPASSWORD="$BACKUP_PASSWORD" exec pg_dump -h 127.0.0.1 -U getexception_backup -d getexception -Fc',
                         stdout=stream)
        if target.stat().st_size == 0:
            raise Failure("Database backup is empty.")
        return target

    def ready(self, release, *, defer_ingest_dns=False):
        self.compose(release, "up", "-d", "--wait", "--wait-timeout", "180", "--no-deps", *SERVICES)
        self.compose(release, "up", "-d", "--wait", "--wait-timeout", "90", "--no-deps", "caddy")
        self.smoke(release, defer_ingest_dns=defer_ingest_dns)

    def smoke(self, release, *, defer_ingest_dns=False):
        config = read_env(self.runtime / ".env")
        # Validate real publicly trusted TLS and both routing boundaries, without auth credentials.
        probes = [(config["DASHBOARD_HOST"], "/login", 200),
                  (config["DASHBOARD_HOST"], "/health/ready", 404)]
        if not defer_ingest_dns:
            probes.append((config["INGEST_HOST"], "/api/dashboard/status", 404))
        for host, path, expected in probes:
            for attempt in range(12):
                try:
                    code = run(["curl", "--silent", "--show-error", "--location", "--max-redirs", "2", "--proto-redir", "=https", "--output", "/dev/null", "--write-out", "%{http_code}",
                                "--connect-timeout", "5", "--max-time", "10", "https://" + host + path], timeout=15)
                    if code == str(expected):
                        break
                except Failure:
                    pass
                if attempt == 11:
                    raise Failure("HTTPS smoke check failed for " + host + path)
                time.sleep(5)
        self.compose(release, "exec", "-T", "ingest", "node", "-e",
                     "fetch('http://127.0.0.1:3001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))")

    def ingestion_smoke(self, release):
        config = read_env(self.runtime / ".env")
        dsn = urllib.parse.urlparse(config.get("SMOKE_DSN", ""))
        origin = config.get("SMOKE_ORIGIN", "")
        key = dsn.username or ""
        project = dsn.path.lstrip("/")
        if (dsn.scheme != "https" or dsn.hostname != config["INGEST_HOST"] or dsn.password
                or dsn.port or dsn.query or dsn.fragment or not re.fullmatch(r"[a-f0-9]{64}", key)
                or not re.fullmatch(r"[a-f0-9-]{36}", project)
                or not re.fullmatch(r"https://[a-z0-9.-]+", origin)):
            raise Failure("Configure SMOKE_DSN and SMOKE_ORIGIN for a dedicated deployment probe project.")
        event_id = secrets.token_hex(16)
        payload = {"event_id": event_id, "timestamp": time.time(), "level": "error", "platform": "javascript",
                   "environment": "production", "release": release.name,
                   "exception": {"values": [{"type": "DeploymentProbe", "value": "GetException deployment probe",
                                              "mechanism": {"type": "generic", "handled": True}}]}}
        body = (json.dumps({"event_id": event_id}) + "\n" + json.dumps({"type": "event"}) + "\n" + json.dumps(payload)).encode()
        url = "https://" + config["INGEST_HOST"] + "/api/" + project + "/envelope/"
        request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-sentry-envelope",
                       "Origin": origin, "X-Sentry-Auth": "Sentry sentry_version=7,sentry_key=" + key})
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 200:
                raise Failure("Deployment event was not accepted.")
        # Only server-generated hex identifiers enter this fixed technical query.
        query = 'SELECT count(*) FROM error_event WHERE "eventId" = \'' + event_id + "'"
        for attempt in range(30):
            count = self.compose(release, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "getexception", "-Atc", query)
            if count == "1":
                return
            time.sleep(1)
        raise Failure("The worker did not finish processing the deployment event.")

    def deploy(self, target, *, first=False, require_ingestion=False, defer_ingest_dns=False):
        if self.pending.exists():
            raise Failure("An unfinished operation exists. Inspect runtime/pending.json and follow the recovery guide.")
        old = self.current() if (self.runtime / "state.json").exists() else None
        if defer_ingest_dns and (not first or old or require_ingestion):
            raise Failure("--defer-ingest-dns is only allowed on the first installation without ingestion smoke.")
        if not first and old is None:
            raise Failure("Installation has not been started; run install first.")
        if old and json.loads((self.runtime / "state.json").read_text()).get("ingestDnsPending"):
            # Fail before any downtime or migration when the initial DNS setup is still incomplete.
            self.smoke(old)
        self.compose(target, "config", "--quiet")
        self.compose(target, "pull")
        self.compose(target, "up", "-d", "--wait", "--wait-timeout", "120", "postgres")
        self.compose(target, "run", "--rm", "--no-deps", "caddy", "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile")
        if old:
            self.backup(old)
        journal = {"previous": old.name if old else None, "target": target.name, "phase": "migration"}
        write_json(self.pending, journal)
        if old:
            self.compose(old, "stop", "caddy", *SERVICES)
        try:
            self.compose(target, "run", "--rm", "--no-deps", "migrate")
        except Failure as exc:
            raise Failure("Migration failed. Services remain stopped; use the recovery guide before retrying.") from exc
        journal["phase"] = "start"
        write_json(self.pending, journal)
        try:
            self.ready(target, defer_ingest_dns=defer_ingest_dns)
            if require_ingestion:
                self.ingestion_smoke(target)
        except (Failure, OSError) as exc:
            target_schema = metadata(target)["schemaVersion"]
            if old and target_schema in metadata(old)["rollbackFromSchemaVersions"]:
                self.compose(target, "stop", "caddy", *SERVICES)
                self.ready(old)
                self.pending.unlink()
                raise Failure("New release failed its health check. The previous release was restored.") from exc
            raise Failure("Release failed; automatic rollback is incompatible or unavailable. Follow the recovery guide.") from exc
        self.switch(target)
        previous = old.name if old else None
        if old == target:
            previous = json.loads((self.runtime / "state.json").read_text()).get("previous")
        write_json(self.runtime / "state.json", {"current": target.name, "previous": previous,
                                                 "ingestDnsPending": defer_ingest_dns})
        self.pending.unlink()
        installed = self.compose(target, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "getexception", "-Atc",
                                 'SELECT count(*) FROM system_setting')
        if installed == "1":
            (self.runtime / "setup-token").unlink(missing_ok=True)
        if defer_ingest_dns:
            print("Dashboard is ready. Public ingest DNS/HTTPS verification is pending; keep automatic deployment disabled.")
        else:
            print("Release " + target.name + " is ready. Existing accounts and data are preserved.")

    def rollback(self):
        if self.pending.exists():
            raise Failure("Resolve the unfinished operation before requesting rollback.")
        state = json.loads((self.runtime / "state.json").read_text())
        previous = state.get("previous")
        current = self.current()
        if not previous or not SHA.fullmatch(previous) or current is None:
            raise Failure("No previous release is available.")
        target = self.root / "releases" / previous
        if metadata(current)["schemaVersion"] not in metadata(target)["rollbackFromSchemaVersions"]:
            raise Failure("The previous release does not support the current database schema.")
        write_json(self.pending, {"previous": current.name, "target": target.name, "phase": "rollback"})
        self.compose(current, "stop", "caddy", *SERVICES)
        self.ready(target)
        self.switch(target)
        write_json(self.runtime / "state.json", {"current": target.name, "previous": current.name})
        self.pending.unlink()
        print("Previous release restored. Database migrations were not reversed.")


@contextlib.contextmanager
def locked(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ["runtime", "releases"]:
        (root / name).mkdir(mode=0o700, exist_ok=True)
    with (root / "runtime/operation.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Failure("Another installation or update is running.") from exc
        yield


def prerequisites():
    if sys.platform != "linux":
        raise Failure("Production installation requires Linux. Use yarn local:start on macOS.")
    for tool in ["docker", "curl", "gh"]:
        if not shutil.which(tool):
            raise Failure("Install " + tool + " first; see docs/deployment.md.")
    run(["docker", "info"], env=docker_environment())
    version = run(["docker", "compose", "version", "--short"], env=docker_environment()).lstrip("v")
    parts = tuple(int(part) for part in version.split(".")[:2])
    if parts < (2, 24):
        raise Failure("Docker Compose 2.24 or newer is required.")
    if os.uname().machine not in ["x86_64", "amd64"]:
        raise Failure("This release targets Linux amd64; an arm64 image is not yet published.")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["install", "update", "rollback", "status", "backup", "smoke"])
    parser.add_argument("--install-dir", default="/opt/getexception")
    parser.add_argument("--release")
    parser.add_argument("--archive-url")
    parser.add_argument("--attestation-bundle", help="Local GitHub attestation bundle for offline verification")
    parser.add_argument("--trusted-root", help="Local trusted root obtained with gh attestation trusted-root")
    parser.add_argument("--skip-start", action="store_true")
    parser.add_argument("--defer-ingest-dns", action="store_true", help="First install only: start dashboard while ingest DNS is pending")
    parser.add_argument("--require-ingestion-smoke", action="store_true")
    parser.add_argument("--dashboard-host")
    parser.add_argument("--ingest-host")
    options = parser.parse_args()
    if options.defer_ingest_dns and (options.command != "install" or options.require_ingestion_smoke or options.skip_start):
        raise Failure("--defer-ingest-dns requires install without --skip-start or --require-ingestion-smoke.")
    root = Path(options.install_dir).expanduser().resolve()
    prerequisites()
    with locked(root):
        installation = Installation(root)
        if options.command in ["install", "update"]:
            if not options.release:
                raise Failure("Specify --release with the full verified release SHA.")
            if installation.pending.exists():
                raise Failure("Resolve runtime/pending.json before installing or updating.")
            if options.command == "update" and not installation.current():
                raise Failure("No running installation exists; use install first.")
            target = fetch_release(root, options.release, options.archive_url,
                                   attestation_bundle=options.attestation_bundle, trusted_root=options.trusted_root)
            config = configure(root, options)
            launcher = '#!/usr/bin/env bash\nset -euo pipefail\nroot="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\nexec python3 "$root/current/getexception.py" "$@" --install-dir "$root"\n'
            atomic_write(root / "getexception", launcher, 0o700)
            if options.skip_start:
                if installation.current() is None:
                    installation.switch(target)
                print("Release downloaded and configuration preserved. Services were not started.")
                return
            installation.deploy(target, first=options.command == "install", require_ingestion=options.require_ingestion_smoke,
                                defer_ingest_dns=options.defer_ingest_dns)
            print("Dashboard: https://" + config["DASHBOARD_HOST"])
            if (root / "runtime/setup-token").exists():
                print("Complete /setup once. Read the private token from " + str(root / "runtime/setup-token"))
        else:
            current = installation.current()
            if current is None:
                raise Failure("No installation found.")
            if options.command == "rollback":
                installation.rollback()
            elif options.command == "backup":
                print("Backup saved: " + str(installation.backup(current)))
            elif options.command == "smoke":
                installation.smoke(current)
                installation.ingestion_smoke(current)
                state_path = installation.runtime / "state.json"
                if state_path.exists():
                    state = json.loads(state_path.read_text())
                    state["ingestDnsPending"] = False
                    write_json(state_path, state)
                print("HTTPS and event processing checks passed.")
            else:
                print("Release: " + current.name)
                print(installation.compose(current, "ps", "--format", "table"))
                if installation.pending.exists():
                    print("An unfinished operation requires inspection: runtime/pending.json")
                state_path = installation.runtime / "state.json"
                if state_path.exists() and json.loads(state_path.read_text()).get("ingestDnsPending"):
                    print("Public ingest DNS/HTTPS verification is pending; keep automatic deployment disabled.")


if __name__ == "__main__":
    try:
        main()
    except (Failure, OSError, ValueError, tarfile.TarError) as error:
        # Never display arbitrary OS/HTTP/JSON errors containing secrets or remote bodies.
        print(str(error) if isinstance(error, Failure) else "Installation failed; check configuration and prerequisites.", file=sys.stderr)
        sys.exit(1)
