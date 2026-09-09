import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

path = Path(__file__).resolve().parents[2] / "scripts/release/image-reference.py"
spec = importlib.util.spec_from_file_location("image_reference", path)
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)

spec = importlib.util.spec_from_file_location("docker_smoke", path.with_name("docker-smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

spec = importlib.util.spec_from_file_location("prepare_release", path.with_name("prepare.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class ReleaseCommandTests(unittest.TestCase):
    def test_release_errors_include_the_cause_and_redact_credentials(self):
        token = secrets.token_urlsafe(24)
        result = argparse.Namespace(returncode=1, stdout="No ancestor could be found", stderr=" credential=" + token)
        with patch.dict(os.environ, {"GH_TOKEN": token}), patch.object(prepare.subprocess, "run", return_value=result):
            with self.assertRaises(RuntimeError) as raised:
                prepare.run("corepack", "yarn", "version", "0.1.1")
        self.assertIn("No ancestor could be found", str(raised.exception))
        self.assertNotIn(token, str(raised.exception))

    def test_release_commands_return_trimmed_stdout(self):
        result = argparse.Namespace(returncode=0, stdout="release-id\n", stderr="")
        with patch.object(prepare.subprocess, "run", return_value=result):
            self.assertEqual(prepare.run("git", "rev-parse", "HEAD"), "release-id")


class DockerSmokeTests(unittest.TestCase):
    def test_compose_errors_keep_diagnostics_without_credentials_or_stdout(self):
        password = secrets.token_urlsafe(24)
        setup = secrets.token_hex(32)
        result = argparse.Namespace(returncode=127, stdout=b"private query output", stderr=f"exec failed: {password} {setup}".encode())
        with patch.object(smoke.subprocess, "run", return_value=result):
            with self.assertRaises(smoke.installer.Failure) as raised:
                smoke.run_compose(["docker", "compose"], [password])
        message = str(raised.exception)
        self.assertIn("127", message)
        self.assertIn("exec failed", message)
        self.assertNotIn(password, message)
        self.assertNotIn(setup, message)
        self.assertNotIn("private query output", message)

    def test_compose_success_returns_query_results(self):
        result = argparse.Namespace(returncode=0, stdout=b"1|1|1|5\n", stderr=b"")
        with patch.object(smoke.subprocess, "run", return_value=result):
            self.assertEqual(smoke.run_compose(["docker", "compose"], []), "1|1|1|5")


class ImageReleaseTests(unittest.TestCase):
    def test_first_package_can_be_published(self):
        error = urllib.error.HTTPError("https://api.github.com", 404, "missing", {}, None)
        with patch.object(images.urllib.request, "urlopen", side_effect=error), patch.object(images.subprocess, "run") as docker:
            self.assertIsNone(images.existing_digest("web", secrets.token_hex(20), "test"))
            docker.assert_not_called()

    def test_existing_sha_is_reused_without_rebuilding(self):
        digest = "sha256:" + secrets.token_hex(32)
        result = argparse.Namespace(returncode=0, stdout=json.dumps({"digest": digest}), stderr="")
        with patch.object(images.urllib.request, "urlopen", return_value=MagicMock()), patch.object(images.subprocess, "run", return_value=result):
            self.assertEqual(images.existing_digest("web", secrets.token_hex(20), "test"), digest)

    def test_missing_tag_in_existing_package_can_be_built(self):
        result = argparse.Namespace(returncode=1, stdout="", stderr="manifest unknown")
        with patch.object(images.urllib.request, "urlopen", return_value=MagicMock()), patch.object(images.subprocess, "run", return_value=result):
            self.assertIsNone(images.existing_digest("web", secrets.token_hex(20), "test"))

    def test_auth_or_registry_failure_never_overwrites_existing_sha(self):
        result = argparse.Namespace(returncode=1, stdout="", stderr="unauthorized")
        with patch.object(images.urllib.request, "urlopen", return_value=MagicMock()), patch.object(images.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "refusing to rebuild"):
                images.existing_digest("web", secrets.token_hex(20), "test")


if __name__ == "__main__":
    unittest.main()
