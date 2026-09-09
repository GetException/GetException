import argparse
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy"))
import getexception as installer

spec = importlib.util.spec_from_file_location("bundle", ROOT / "scripts/release/bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class SimulatedInstallation(installer.Installation):
    def __init__(self, root):
        super().__init__(root)
        self.calls = []
        self.fail_migration = False
        self.fail_health = None

    def compose(self, release, *args, **kwargs):
        self.calls.append((release.name, args))
        if args[-1] == "migrate" and self.fail_migration:
            raise installer.Failure("migration failed")
        return "1"

    def backup(self, release):
        self.calls.append((release.name, ("backup",)))

    def ready(self, release):
        self.calls.append((release.name, ("ready",)))
        if release == self.fail_health:
            raise installer.Failure("unhealthy")


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        (self.root / "runtime").mkdir()
        (self.root / "releases").mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def release(self, schema=3, compatible=None):
        sha = secrets.token_hex(20)
        directory = self.root / "releases" / sha
        directory.mkdir()
        installer.write_json(directory / "release.json", {
            "sha": sha, "repository": installer.REPOSITORY, "schemaVersion": schema,
            "rollbackFromSchemaVersions": compatible if compatible is not None else [3],
            "images": {name: "ghcr.io/getexception/getexception-" + name + "@sha256:" + secrets.token_hex(32)
                       for name in ["web", "ingest", "worker", "mail", "migrate"]}})
        return directory

    def active(self):
        installation = SimulatedInstallation(self.root)
        old = self.release()
        installation.switch(old)
        installer.write_json(self.root / "runtime/state.json", {"current": old.name, "previous": None})
        return installation, old

    def test_configuration_survives_reinstallation_and_never_executes_shell(self):
        options = argparse.Namespace(dashboard_host="monitor.example.com", ingest_host="ingest.example.com")
        env = {"SMTP_HOST": "smtp.example.com", "SMTP_FROM": "monitor@example.com", "ACME_EMAIL": "admin@example.com",
               "SMTP_PASSWORD": "a'quoted\\value$with`literal`$(text)"}
        with patch.dict(os.environ, env, clear=True):
            first = installer.configure(self.root, options)
            token = (self.root / "runtime/setup-token").read_bytes()
            second = installer.configure(self.root, options)
        self.assertEqual(first, second)
        self.assertEqual(first["SMTP_PASSWORD"], env["SMTP_PASSWORD"])
        self.assertEqual(token, (self.root / "runtime/setup-token").read_bytes())
        self.assertEqual((self.root / "runtime/.env").stat().st_mode & 0o777, 0o600)
        self.assertEqual(len({first[key] for key in installer.SECRET_KEYS}), len(installer.SECRET_KEYS))

    def test_rejects_weak_reused_and_invalid_configuration(self):
        options = argparse.Namespace(dashboard_host="monitor.example.com", ingest_host="ingest.example.com")
        with patch.dict(os.environ, {"WEB_PASSWORD": "weak"}, clear=True), self.assertRaises(installer.Failure):
            installer.configure(self.root, options)
        self.assertFalse((self.root / "runtime/.env").exists())
        for host in ["localhost", "monitor.localhost", "../../etc", "example.com:443", "https://example.com", "-bad.example"]:
            with self.assertRaises(installer.Failure):
                installer.domain(host)

    def test_parallel_operations_are_rejected(self):
        with installer.locked(self.root):
            with self.assertRaises(installer.Failure), installer.locked(self.root):
                pass

    def test_successful_update_preserves_data_and_orders_migration_before_start(self):
        installation, old = self.active()
        marker = self.root / "runtime/owner-marker"
        marker.write_text("existing owner")
        target = self.release()
        installation.deploy(target)
        self.assertEqual(installation.current(), target)
        self.assertEqual(marker.read_text(), "existing owner")
        self.assertEqual(json.loads((self.root / "runtime/state.json").read_text())["previous"], old.name)
        self.assertFalse(installation.pending.exists())
        operations = [args for _, args in installation.calls]
        self.assertLess(operations.index(("backup",)), operations.index(("run", "--rm", "--no-deps", "migrate")))
        self.assertLess(operations.index(("run", "--rm", "--no-deps", "migrate")), operations.index(("ready",)))

    def test_health_failure_restores_previous_release_and_reports_failure(self):
        installation, old = self.active()
        target = self.release()
        installation.fail_health = target
        with self.assertRaisesRegex(installer.Failure, "previous release was restored"):
            installation.deploy(target)
        self.assertEqual(installation.current(), old)
        self.assertFalse(installation.pending.exists())
        self.assertEqual(installation.calls[-1], (old.name, ("ready",)))

    def test_failed_migration_keeps_journal_and_blocks_retry(self):
        installation, old = self.active()
        target = self.release()
        installation.fail_migration = True
        with self.assertRaisesRegex(installer.Failure, "Migration failed"):
            installation.deploy(target)
        self.assertTrue(installation.pending.exists())
        self.assertEqual(installation.current(), old)
        self.assertNotIn((target.name, ("ready",)), installation.calls)
        with self.assertRaisesRegex(installer.Failure, "unfinished"):
            installation.deploy(target)

    def test_incompatible_schema_never_triggers_automatic_rollback(self):
        installation, old = self.active()
        target = self.release(schema=4)
        installation.fail_health = target
        with self.assertRaisesRegex(installer.Failure, "incompatible"):
            installation.deploy(target)
        self.assertTrue(installation.pending.exists())
        self.assertNotIn((old.name, ("ready",)), installation.calls)

    def test_manual_rollback_does_not_execute_migrations_or_delete_data(self):
        installation, old = self.active()
        target = self.release()
        installation.deploy(target)
        installation.calls.clear()
        installation.rollback()
        self.assertEqual(installation.current(), old)
        self.assertFalse(any("migrate" in args for _, args in installation.calls))

    def test_repeated_update_does_not_forget_previous_release(self):
        installation, old = self.active()
        target = self.release()
        installation.deploy(target)
        installation.deploy(target)
        self.assertEqual(json.loads((self.root / "runtime/state.json").read_text())["previous"], old.name)

    def test_staged_first_install_does_not_backup_an_uninitialized_schema(self):
        installation = SimulatedInstallation(self.root)
        target = self.release()
        installation.switch(target)
        installation.deploy(target, first=True)
        self.assertFalse(any(args == ("backup",) for _, args in installation.calls))

    def test_release_bundle_has_only_expected_files_and_no_secrets(self):
        release = self.release()
        info = installer.metadata(release)
        output = self.root / "output"
        bundle.build_bundle(info["sha"], info["images"], output)
        destination = self.root / "extracted"
        destination.mkdir()
        installer.extract_archive(output / "getexception.tar.gz", destination)
        self.assertEqual({entry.name for entry in destination.iterdir()}, installer.FILES)
        self.assertEqual(installer.metadata(destination)["sha"], info["sha"])
        self.assertEqual((destination / "init-db.sh").stat().st_mode & 0o777, 0o644)
        bundle.build_bundle(info["sha"], info["images"], self.root / "second-output")
        self.assertEqual((output / "getexception.tar.gz").read_bytes(), (self.root / "second-output/getexception.tar.gz").read_bytes())

    def test_decompression_bomb_is_rejected_before_tar_parsing(self):
        path = self.root / "bomb.tar.gz"
        path.write_bytes(gzip.compress(b"\0" * 12_030_721))
        with self.assertRaisesRegex(installer.Failure, "Expanded"):
            installer.extract_archive(path, self.root / "unpack")

    def test_compose_preserves_literal_smtp_password(self):
        executable = ROOT / ".artifacts/tools/docker-compose"
        command = [str(executable)] if executable.exists() else (["docker", "compose"] if shutil.which("docker") else None)
        if command is None:
            if os.environ.get("CI"):
                self.fail("Docker Compose is required in CI")
            self.skipTest("Docker Compose CLI is unavailable")
        value = "a'quoted\\value$with`literal`$(text)é"
        (self.root / ".env").write_text(installer.env_text({"TEST_VALUE": value}))
        (self.root / "compose.json").write_text(json.dumps({"services": {"test": {"image": "node:24", "environment": {"TEST_VALUE": "${TEST_VALUE}"}}}}))
        rendered = subprocess.check_output([*command, "--env-file", str(self.root / ".env"), "-f", str(self.root / "compose.json"),
                                            "config", "--environment"], text=True)
        self.assertIn("TEST_VALUE=" + value, rendered.splitlines())

    def test_unsafe_archives_never_write_outside_destination(self):
        for name, kind in [("../outside", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                           ("getexception.py", tarfile.SYMTYPE), ("getexception.py", tarfile.LNKTYPE)]:
            archive = self.root / "unsafe.tar.gz"
            with tarfile.open(archive, "w:gz") as stream:
                for path in installer.FILES - {"getexception.py"}:
                    info = tarfile.TarInfo(path)
                    stream.addfile(info, io.BytesIO())
                info = tarfile.TarInfo(name)
                info.type = kind
                info.linkname = "../../outside"
                stream.addfile(info, io.BytesIO())
            destination = self.root / "unpack"
            destination.mkdir(exist_ok=True)
            with self.assertRaises(installer.Failure):
                installer.extract_archive(archive, destination)
            self.assertEqual(list(destination.iterdir()), [])

    def test_failed_attestation_does_not_install_bundle(self):
        release = self.release()
        info = installer.metadata(release)
        output = self.root / "output"
        bundle.build_bundle(info["sha"], info["images"], output)
        def download(url, path):
            path.write_bytes((output / path.name).read_bytes())
        with patch.object(installer, "download", download), patch.object(installer, "run", side_effect=installer.Failure("bad signature")):
            with self.assertRaisesRegex(installer.Failure, "bad signature"):
                installer.fetch_release(self.root, info["sha"])
        self.assertEqual(list(release.iterdir()), [release / "release.json"])


if __name__ == "__main__":
    unittest.main()
