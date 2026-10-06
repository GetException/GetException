import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch, MagicMock

path = Path(__file__).resolve().parents[2] / "scripts/release/ssh-deploy.py"
spec = importlib.util.spec_from_file_location("ssh_deploy", path)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class SshDeployTests(unittest.TestCase):
    def setUp(self):
        self.previous_umask = os.umask(0o077)
        self.addCleanup(os.umask, self.previous_umask)
        self.sha = secrets.token_hex(20)
        self.proofs = {"attestation.jsonl": "public bundle", "controller-attestation.jsonl": "public controller proof", "trusted-root.jsonl": "public root"}
        self.env = {"DEPLOY_HOST": "server.example.com", "DEPLOY_USER": "deploy", "RELEASE_SHA": self.sha,
                    "DEPLOY_SSH_KEY": secrets.token_urlsafe(32), "DEPLOY_KNOWN_HOSTS": "verified host",
                    "GH_TOKEN": secrets.token_urlsafe(32), "NPM_TOKEN": secrets.token_urlsafe(32), "PATH": os.environ["PATH"]}

    def test_ssh_gets_only_public_proofs_and_quoted_arguments(self):
        self.env["DEPLOY_DIR"] = "/opt/installation with spaces; literal"

        def ssh(command, **options):
            self.assertEqual(command[0], "ssh")
            self.assertIn("StrictHostKeyChecking=yes", command)
            self.assertIn("IdentitiesOnly=yes", command)
            key = Path(command[command.index("-i") + 1])
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)
            self.assertEqual(key.read_text().strip(), self.env["DEPLOY_SSH_KEY"])
            remote = shlex.split(command[-1])
            self.assertEqual(remote, ["python3", "-c", deploy.REMOTE_UPDATE, self.env["DEPLOY_DIR"], self.sha])
            self.assertEqual(json.loads(options["input"]), self.proofs)
            for key in ["GH_TOKEN", "NPM_TOKEN", "DEPLOY_SSH_KEY"]:
                self.assertNotIn(key, options["env"])
                self.assertNotIn(self.env[key], options["input"] + command[-1])

        with patch.object(deploy, "release_proofs", return_value=self.proofs), patch.object(deploy.subprocess, "run", side_effect=ssh):
            deploy.deploy(self.env)

    def test_invalid_checksum_stops_before_attestation_or_ssh(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "getexception.tar.gz").write_bytes(b"bundle")
            (root / "getexception.tar.gz.sha256").write_text("wrong getexception.tar.gz\n")
            with patch.object(deploy.subprocess, "run") as command:
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    deploy.release_proofs(self.sha, root)
            self.assertEqual(command.call_count, 1)

    def test_invalid_attestation_prevents_ssh(self):
        def command(args, **options):
            if args[1:3] == ["release", "download"]:
                root = Path(args[args.index("--dir") + 1])
                (root / "getexception.tar.gz").write_bytes(b"bundle")
                (root / "getexception.tar.gz.sha256").write_text(hashlib.sha256(b"bundle").hexdigest() + " getexception.tar.gz\n")
                (root / "getexception.py").write_bytes(b"controller")
                (root / "getexception.py.sha256").write_text(hashlib.sha256(b"controller").hexdigest() + " getexception.py\n")
            if args[1:3] == ["attestation", "trusted-root"]:
                options["stdout"].write("public root")
            if args[1:3] == ["attestation", "verify"]:
                self.assertIn(deploy.WORKFLOW, args)
                self.assertIn(self.sha, args)
                self.assertIn("--custom-trusted-root", args)
                raise subprocess.CalledProcessError(1, args)
            self.assertNotEqual(args[0], "ssh")

        with patch.object(deploy.subprocess, "run", side_effect=command):
            with self.assertRaises(subprocess.CalledProcessError):
                deploy.deploy(self.env)

    def test_remote_adapter_preserves_configuration_and_requires_verified_ingestion(self):
        namespace = {"__name__": "test_remote"}
        exec(deploy.REMOTE_UPDATE, namespace)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runtime").mkdir()
            (root / "getexception").write_text("existing controller")
            (root / "runtime/.env").write_text("persisted private settings")
            response = MagicMock()
            response.__enter__.return_value = response
            response.geturl.return_value = "https://release-assets.githubusercontent.com/controller"
            response.read.return_value = b"verified controller"
            with patch.object(deploy.subprocess, "run", side_effect=[argparse.Namespace(returncode=0), argparse.Namespace(returncode=7)]) as command, \
                 patch.object(namespace["urllib"].request, "urlopen", return_value=response):
                self.assertEqual(namespace["update"](directory, self.sha, self.proofs), 7)
            args = command.call_args.args[0]
            controller = root / "runtime/deployments" / self.sha / "getexception.py"
            self.assertEqual(args[:7], ["python3", str(controller), "update", "--install-dir", str(root), "--release", self.sha])
            self.assertEqual(command.call_args_list[0].args[0][:3], ["gh", "attestation", "verify"])
            self.assertEqual(controller.read_bytes(), b"verified controller")
            self.assertIn("--require-ingestion-smoke", args)
            for flag, name in [("--attestation-bundle", "attestation.jsonl"), ("--trusted-root", "trusted-root.jsonl")]:
                proof = Path(args[args.index(flag) + 1])
                self.assertEqual(proof.read_text(), self.proofs[name])
                self.assertEqual(proof.stat().st_mode & 0o777, 0o600)
            self.assertEqual((root / "runtime/.env").read_text(), "persisted private settings")

    def test_unverified_new_controller_cannot_update_the_old_installation(self):
        namespace = {"__name__": "test_remote"}
        exec(deploy.REMOTE_UPDATE, namespace)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "runtime").mkdir()
            (root / "getexception").write_text("old controller")
            (root / "runtime/.env").write_text("persistent config")
            response = MagicMock()
            response.__enter__.return_value = response
            response.geturl.return_value = "https://release-assets.githubusercontent.com/controller"
            response.read.return_value = b"unverified controller"
            with patch.object(deploy.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["gh"])) as command, \
                 patch.object(namespace["urllib"].request, "urlopen", return_value=response):
                with self.assertRaises(subprocess.CalledProcessError):
                    namespace["update"](directory, self.sha, self.proofs)
            self.assertEqual(command.call_count, 1)
            self.assertEqual(command.call_args.args[0][:3], ["gh", "attestation", "verify"])
            self.assertEqual((root / "getexception").read_text(), "old controller")
            self.assertEqual((root / "runtime/.env").read_text(), "persistent config")

    def test_controller_checksum_is_verified_before_attestation_or_ssh(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "getexception.tar.gz").write_bytes(b"bundle")
            (root / "getexception.tar.gz.sha256").write_text(hashlib.sha256(b"bundle").hexdigest() + " getexception.tar.gz\n")
            (root / "getexception.py").write_bytes(b"controller")
            (root / "getexception.py.sha256").write_text("wrong getexception.py\n")
            with patch.object(deploy.subprocess, "run") as command:
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    deploy.release_proofs(self.sha, root)
            self.assertEqual(command.call_count, 1)

    def test_controller_download_rejects_insecure_redirects_and_oversized_files(self):
        namespace = {"__name__": "test_remote"}
        exec(deploy.REMOTE_UPDATE, namespace)
        for url, content in [("http://example.test/controller", b"controller"),
                             ("https://release-assets.githubusercontent.com/controller", b"a" * 2000001)]:
            with self.subTest(url=url), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "runtime").mkdir()
                (root / "getexception").write_text("old controller")
                (root / "runtime/.env").write_text("persistent config")
                response = MagicMock()
                response.__enter__.return_value = response
                response.geturl.return_value = url
                response.read.return_value = content
                with patch.object(deploy.subprocess, "run") as command, \
                     patch.object(namespace["urllib"].request, "urlopen", return_value=response):
                    with self.assertRaises(RuntimeError):
                        namespace["update"](directory, self.sha, self.proofs)
                command.assert_not_called()

    def test_missing_installation_or_invalid_transport_parameters_fail_closed(self):
        for key, value in [("DEPLOY_HOST", "host; command"), ("DEPLOY_USER", "root; command"),
                           ("DEPLOY_PORT", "65536"), ("DEPLOY_DIR", "/opt/app\ncommand"),
                           ("RELEASE_SHA", "../release"), ("DEPLOY_SSH_KEY", "")]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                deploy.parameters({**self.env, key: value})
        namespace = {"__name__": "test_remote"}
        exec(deploy.REMOTE_UPDATE, namespace)
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy.subprocess, "run") as command:
            with self.assertRaisesRegex(RuntimeError, "existing installation"):
                namespace["update"](directory, self.sha, self.proofs)
            command.assert_not_called()
