#!/usr/bin/env python3
"""Encrypted offsite PostgreSQL/config backups and offline authenticated unpacking."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.parse

from getexception import Failure, Installation, locked, metadata, run, write_json


MAX_ARCHIVE = 5 * 1024 ** 3
RESERVE = 5 * 1024 ** 3
MEMBERS = {"database.dump", "runtime.env", "manifest.json"}


def private_file(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise Failure("Backup configuration and keys must be owned by this user, regular files and mode 0600.")
    return path


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def configuration(path):
    value = json.loads(private_file(path).read_text())
    required = {"recipient", "bucket", "prefix", "region", "credentialsFile"}
    if not isinstance(value, dict) or not required <= value.keys() or value.keys() - required - {"endpoint"}:
        raise Failure("Invalid backup configuration; see docs/backups.md.")
    if not all(isinstance(item, str) for item in value.values()):
        raise Failure("Backup settings must be strings.")
    if not re.fullmatch(r"age1[0-9a-z]{58}", value["recipient"]):
        raise Failure("Use an age X25519 public recipient; private identities never belong on production.")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", value["bucket"]):
        raise Failure("Invalid backup bucket name.")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}/", value["prefix"]):
        raise Failure("Use a bounded backup prefix ending in /.")
    if not re.fullmatch(r"[a-z0-9-]{1,64}", value["region"]):
        raise Failure("Invalid backup region.")
    if value.get("endpoint"):
        url = urllib.parse.urlsplit(value["endpoint"])
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise Failure("The backup endpoint must be an exact HTTPS origin.")
    credentials = Path(value["credentialsFile"])
    if not credentials.is_absolute():
        raise Failure("Use an absolute path to the dedicated write-only AWS credentials file.")
    private_file(credentials)
    return value


def tool(name):
    binary = shutil.which(name)
    if not binary:
        raise Failure("Install verified " + name + " first; see docs/backups.md.")
    return binary


def make_archive(installation, release, directory):
    dump = directory / "database.dump"
    dump_limit = min(MAX_ARCHIVE - 1024 * 1024, (shutil.disk_usage(directory).free - RESERVE) // 3)
    if dump_limit < 16 * 1024 * 1024:
        raise Failure("Backup cannot preserve the 5 GiB disk reserve.")
    with dump.open("xb") as output:
        installation.compose(release, "exec", "-T", "postgres", "sh", "-c",
                             'PGPASSWORD="$BACKUP_PASSWORD" exec pg_dump -h 127.0.0.1 -U getexception_backup -d getexception -Fc', stdout=output, output_limit=dump_limit)
    if not 0 < dump.stat().st_size < MAX_ARCHIVE - 1024 * 1024:
        raise Failure("Database dump is empty or exceeds the 5 GiB single-object backup limit.")
    runtime = private_file(installation.runtime / ".env")
    info = metadata(release)
    manifest = json.dumps({"version": 1, "release": info, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                           "sha256": {"database.dump": checksum(dump).hex(), "runtime.env": checksum(runtime).hex()}}, sort_keys=True).encode()
    archive = directory / "backup.tar"
    with tarfile.open(archive, "w") as bundle:
        for name, source in [("database.dump", dump), ("runtime.env", runtime)]:
            entry = tarfile.TarInfo(name)
            entry.size = source.stat().st_size
            entry.mode = 0o600
            with source.open("rb") as stream:
                bundle.addfile(entry, stream)
        entry = tarfile.TarInfo("manifest.json")
        entry.size = len(manifest)
        entry.mode = 0o600
        bundle.addfile(entry, io.BytesIO(manifest))
    dump.unlink()
    return archive


def create_offsite(installation):
    if installation.pending.exists():
        raise Failure("Resolve the unfinished deployment before taking an offsite backup.")
    release = installation.current()
    if release is None:
        raise Failure("No running installation exists.")
    config = configuration(installation.runtime / "backup.json")
    age, aws = tool("age"), tool("aws")
    directory = installation.runtime / "backups"
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    name = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + secrets.token_hex(16) + ".tar.age"
    encrypted = directory / name
    with tempfile.TemporaryDirectory(prefix=".offsite-", dir=directory) as temporary:
        archive = make_archive(installation, release, Path(temporary))
        run([age, "--encrypt", "--recipient", config["recipient"], "--output", str(encrypted), str(archive)], stdout=subprocess.DEVNULL)
    if not 0 < encrypted.stat().st_size <= MAX_ARCHIVE:
        raise Failure("Encrypted backup exceeds the 5 GiB single-object limit.")
    digest = checksum(encrypted)
    key = config["prefix"] + name
    # No ambient credentials, profiles, endpoints or metadata credentials may replace this dedicated writer.
    env = {key: os.environ[key] for key in ["PATH", "HOME", "SSL_CERT_FILE", "AWS_CA_BUNDLE"] if key in os.environ}
    env.update(AWS_SHARED_CREDENTIALS_FILE=config["credentialsFile"], AWS_CONFIG_FILE=os.devnull,
               AWS_EC2_METADATA_DISABLED="true", AWS_DEFAULT_REGION=config["region"], AWS_PAGER="")
    command = [aws, "s3api", "put-object", "--bucket", config["bucket"], "--key", key,
               "--body", str(encrypted), "--if-none-match", "*", "--checksum-algorithm", "SHA256",
               "--checksum-sha256", base64.b64encode(digest).decode(), "--no-cli-pager"]
    if config.get("endpoint"):
        command.extend(["--endpoint-url", config["endpoint"]])
    run(command, env=env, stdout=subprocess.DEVNULL, timeout=3600)
    receipt = {"completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "bucket": config["bucket"],
               "key": key, "sha256": digest.hex(), "bytes": encrypted.stat().st_size, "release": release.name}
    write_json(installation.runtime / "backup-status.json", receipt)
    # The remote lifecycle owns retention; the writer never lists/deletes other objects.
    encrypted.unlink()
    return receipt


def unpack(encrypted, identity, output):
    encrypted, output = Path(encrypted), Path(output)
    private_file(identity)
    if output.exists() or not encrypted.is_file() or not 0 < encrypted.stat().st_size <= MAX_ARCHIVE:
        raise Failure("Use an existing encrypted backup and a new output directory.")
    with tempfile.TemporaryDirectory(prefix=".restore-", dir=output.parent) as temporary:
        directory = Path(temporary)
        archive = directory / "backup.tar"
        # age authenticates the complete file before any database/config file is exposed to restore.
        run([tool("age"), "--decrypt", "--identity", str(identity), "--output", str(archive), str(encrypted)], stdout=subprocess.DEVNULL)
        validate_archive(archive)
        with tarfile.open(archive, "r:") as bundle:
            entries = bundle.getmembers()
            if len(entries) != 3 or {entry.name for entry in entries} != MEMBERS or any(
                    not entry.isfile() or entry.size <= 0 or entry.size > MAX_ARCHIVE for entry in entries):
                raise Failure("Unexpected paths, duplicate entries or invalid files in backup.")
            if sum(entry.size for entry in entries) > MAX_ARCHIVE:
                raise Failure("Backup contents exceed the restore limit.")
            for entry in entries:
                if entry.name != "database.dump" and entry.size > 1024 * 1024:
                    raise Failure("Backup metadata exceeds its size limit.")
            manifest = json.load(bundle.extractfile("manifest.json"))
            if manifest.get("version") != 1 or set(manifest.get("sha256", {})) != MEMBERS - {"manifest.json"}:
                raise Failure("Invalid backup manifest.")
            restored = directory / "restored"
            restored.mkdir(mode=0o700)
            for name in ["database.dump", "runtime.env"]:
                with bundle.extractfile(name) as source, (restored / name).open("xb") as target:
                    shutil.copyfileobj(source, target)
                os.chmod(restored / name, 0o600)
                if checksum(restored / name).hex() != manifest["sha256"][name]:
                    raise Failure("Backup checksum verification failed.")
            write_json(restored / "release.json", manifest["release"])
            metadata(restored)
            os.rename(restored, output)


def validate_archive(path):
    # Reject extension/PAX headers before tarfile can allocate attacker-sized metadata.
    names = set()
    with Path(path).open("rb") as stream:
        while True:
            header = stream.read(512)
            if header == b"\0" * 512:
                padding = stream.read(10241)
                if len(padding) > 10240 or any(padding) or names != MEMBERS:
                    raise Failure("Invalid backup archive padding or members.")
                return
            try:
                entry = tarfile.TarInfo.frombuf(header, "utf8", "strict")
            except (tarfile.HeaderError, UnicodeError) as exc:
                raise Failure("Invalid backup archive header.") from exc
            if entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or entry.name not in MEMBERS or entry.name in names:
                raise Failure("Unexpected or duplicate backup member.")
            limit = MAX_ARCHIVE if entry.name == "database.dump" else 1024 * 1024
            if not 0 < entry.size <= limit:
                raise Failure("Backup member exceeds its size limit.")
            names.add(entry.name)
            stream.seek(((entry.size + 511) // 512) * 512, os.SEEK_CUR)
            if stream.tell() > MAX_ARCHIVE:
                raise Failure("Backup archive exceeds its size limit.")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--install-dir", default="/opt/getexception")
    restore = commands.add_parser("unpack")
    restore.add_argument("--file", required=True)
    restore.add_argument("--identity", required=True)
    restore.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        if args.command == "create":
            with locked(Path(args.install_dir).resolve()):
                create_offsite(Installation(Path(args.install_dir).resolve()))
            print("Encrypted offsite backup uploaded; receipt saved in runtime/backup-status.json.")
        else:
            unpack(args.file, args.identity, args.output)
            print("Backup authenticated and unpacked. Restore only into an empty isolated database; see docs/backups.md.")
    except (Failure, OSError, ValueError, tarfile.TarError) as exc:
        # Third-party command output and configuration values may contain credentials.
        raise SystemExit(str(exc) if isinstance(exc, Failure) else "Backup operation failed; inspect local configuration and files.") from None


if __name__ == "__main__":
    main()
