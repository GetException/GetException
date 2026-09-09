import argparse
import importlib.util
import json
from pathlib import Path
import secrets
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

path = Path(__file__).resolve().parents[2] / "scripts/release/image-reference.py"
spec = importlib.util.spec_from_file_location("image_reference", path)
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)


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
