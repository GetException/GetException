"""Real age roundtrip plus backup permissions, corruption and bounded parsing."""
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
import backup
import getexception


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.environment = patch.dict(os.environ, {"PATH": str(ROOT / ".artifacts/tools") + os.pathsep + os.environ.get("PATH", "")})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.temporary.cleanup)
        self.assertIsNotNone(shutil.which("age"), "Run yarn ci:tools to install pinned age")
        self.identity = self.root / "identity"
        getexception.run(["age-keygen", "--output", str(self.identity)], stdout=subprocess.DEVNULL)
        self.recipient = getexception.run(["age-keygen", "-y", str(self.identity)])
        runtime = self.root / "runtime"
        runtime.mkdir(mode=0o700)
        getexception.atomic_write(runtime / ".env", 'TOTP_ENCRYPTION_KEY="' + secrets.token_hex(32) + '"\n')
        getexception.atomic_write(runtime / "writer", "[default]\naws_access_key_id=fixture\naws_secret_access_key=fixture\n")
        getexception.write_json(runtime / "backup.json", {"recipient": self.recipient, "bucket": "getexception-test",
                                                       "prefix": "daily/", "region": "us-east-1", "credentialsFile": str(runtime / "writer")})
        release = self.root / "releases" / secrets.token_hex(20)
        release.mkdir(parents=True)
        getexception.write_json(release / "release.json", {"repository": getexception.REPOSITORY, "sha": release.name,
                               "schemaVersion": 10, "rollbackFromSchemaVersions": [10],
                               "images": {name: "ghcr.io/getexception/getexception-" + name + "@sha256:" + secrets.token_hex(32)
                                          for name in ["web", "ingest", "worker", "migrate"]}})
        (self.root / "current").symlink_to(release)
        self.payload = b"PGDMP-fixture-" + secrets.token_bytes(64)
        owner = self

        class Fixture(getexception.Installation):
            def compose(self, release, *args, stdout=None, output_limit=None):
                owner.assertGreater(output_limit, len(owner.payload))
                owner.assertIn("getexception_backup", args[-1])
                stdout.write(owner.payload)
        self.installation = Fixture(self.root)
        self.remote = self.root / "remote.age"
        self.real_run = getexception.run

    def invoke(self, args, **kwargs):
        if args[0] == "aws":
            self.assertIn("--if-none-match", args)
            self.assertEqual(args[args.index("--if-none-match") + 1], "*")
            self.assertEqual(args[args.index("--checksum-algorithm") + 1], "SHA256")
            self.assertNotIn("AWS_SECRET_ACCESS_KEY", kwargs["env"])
            source = Path(args[args.index("--body") + 1])
            shutil.copyfile(source, self.remote)
            return ""
        return self.real_run(args, **kwargs)

    def create(self):
        real_tool = backup.tool
        with patch.object(backup, "tool", side_effect=lambda name: "aws" if name == "aws" else real_tool(name)), \
             patch.object(backup, "run", side_effect=self.invoke), \
             patch.object(backup.shutil, "disk_usage", return_value=shutil._ntuple_diskusage(30 * 1024**3, 0, 30 * 1024**3)):
            return backup.create_offsite(self.installation)

    def test_roundtrip_includes_config_and_requires_a_new_restore_directory(self):
        receipt = self.create()
        self.assertEqual(receipt["sha256"], backup.checksum(self.remote).hex())
        self.assertNotIn(self.payload, self.remote.read_bytes())
        output = self.root / "restored"
        backup.unpack(self.remote, self.identity, output)
        self.assertEqual((output / "database.dump").read_bytes(), self.payload)
        self.assertEqual((output / "runtime.env").read_bytes(), (self.root / "runtime/.env").read_bytes())
        self.assertEqual((output / "runtime.env").stat().st_mode & 0o777, 0o600)
        self.assertEqual(list((self.root / "runtime/backups").iterdir()), [])
        with self.assertRaises(getexception.Failure):
            backup.unpack(self.remote, self.identity, output)

    def test_corruption_and_wrong_identity_never_expose_partial_restore(self):
        self.create()
        wrong = self.root / "wrong"
        self.real_run(["age-keygen", "--output", str(wrong)], stdout=subprocess.DEVNULL)
        output = self.root / "restored"
        with self.assertRaises(getexception.Failure):
            backup.unpack(self.remote, wrong, output)
        self.assertFalse(output.exists())
        data = bytearray(self.remote.read_bytes())
        data[-1] ^= 1
        self.remote.write_bytes(data)
        with self.assertRaises(getexception.Failure):
            backup.unpack(self.remote, self.identity, output)
        self.assertFalse(output.exists())

    def test_public_or_symlinked_credentials_are_rejected(self):
        config = self.root / "runtime/backup.json"
        config.chmod(0o644)
        with self.assertRaises(getexception.Failure):
            backup.configuration(config)
        config.chmod(0o600)
        value = json.loads(config.read_text())
        link = self.root / "link"
        link.symlink_to(value["credentialsFile"])
        value["credentialsFile"] = str(link)
        getexception.write_json(config, value)
        with self.assertRaises(getexception.Failure):
            backup.configuration(config)

    def test_failed_upload_does_not_record_success_or_leave_plaintext(self):
        invoke = self.invoke
        def failure(args, **kwargs):
            if args[0] == "aws":
                raise getexception.Failure("upload unavailable")
            return invoke(args, **kwargs)
        self.invoke = failure
        with self.assertRaises(getexception.Failure):
            self.create()
        self.assertFalse((self.root / "runtime/backup-status.json").exists())
        files = list((self.root / "runtime/backups").iterdir())
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].name.endswith(".tar.age"))

    def test_archive_extensions_links_and_duplicate_paths_are_rejected(self):
        for name, kind, size in [("../runtime.env", tarfile.REGTYPE, 1), ("database.dump", tarfile.SYMTYPE, 0),
                                 ("metadata", tarfile.XHDTYPE, 2**30)]:
            archive = self.root / "hostile.tar"
            info = tarfile.TarInfo(name)
            info.type, info.size = kind, size
            archive.write_bytes(info.tobuf())
            with self.assertRaises(getexception.Failure):
                backup.validate_archive(archive)
        with tarfile.open(self.root / "duplicates.tar", "w") as archive:
            for _ in range(2):
                info = tarfile.TarInfo("runtime.env")
                info.size = 1
                archive.addfile(info, io.BytesIO(b"x"))
        with self.assertRaises(getexception.Failure):
            backup.validate_archive(self.root / "duplicates.tar")

    def test_dump_output_is_bounded_without_buffering_the_full_stream(self):
        with (self.root / "limited").open("wb") as output:
            with self.assertRaisesRegex(getexception.Failure, "budget"):
                getexception.run_limited([sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'x'*1000000)"],
                                        env=None, output=output, limit=100_000, timeout=10)
        self.assertLessEqual((self.root / "limited").stat().st_size, 100_000)


if __name__ == "__main__":
    unittest.main()
