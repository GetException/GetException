import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy"))
import getexception as installer


class NetworkPolicyTests(unittest.TestCase):
    def test_compose_overlays_policy_without_mutating_the_verified_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "runtime").mkdir()
            release = root / ("a" * 40)
            release.mkdir()
            original = b"services: {}\n"
            (release / "compose.yaml").write_bytes(original)
            installation = installer.Installation(root)
            with patch.object(installer, "metadata", return_value={"images": {"web": "image"}}), patch.object(installer, "run", return_value="") as run:
                installation.compose(release, "ps")
            overlay = root / "runtime" / ("mptcp-" + release.name + ".compose.json")
            policy = json.loads(overlay.read_text())
            self.assertEqual(set(policy["services"]), {"postgres", "migrate", "web", "ingest", "worker-events", "worker-retention", "caddy"})
            self.assertTrue(all(service["sysctls"]["net.mptcp.enabled"] == "0" for service in policy["services"].values()))
            self.assertIn(str(overlay), run.call_args.args[0])
            self.assertEqual((release / "compose.yaml").read_bytes(), original)

    def test_verification_accepts_disabled_persistent_and_effective_values(self):
        installation = installer.Installation(Path("unused"))
        with patch.object(installation, "compose", return_value="container"), patch.object(installer, "run", side_effect=["0", "123", "0"]):
            installation.verify_mptcp(Path("unused"))

    def test_verification_rejects_enabled_namespace(self):
        installation = installer.Installation(Path("unused"))
        with patch.object(installation, "compose", return_value="container"), patch.object(installer, "run", side_effect=["0", "123", "1"]):
            with self.assertRaises(installer.Failure):
                installation.verify_mptcp(Path("unused"))

    def test_verification_rejects_missing_persistent_policy(self):
        installation = installer.Installation(Path("unused"))
        with patch.object(installation, "compose", return_value="container"), patch.object(installer, "run", side_effect=["<no value>", "123"]):
            with self.assertRaises(installer.Failure):
                installation.verify_mptcp(Path("unused"))

    def test_verification_rejects_an_empty_deployment(self):
        installation = installer.Installation(Path("unused"))
        with patch.object(installation, "compose", return_value=""):
            with self.assertRaises(installer.Failure):
                installation.verify_mptcp(Path("unused"))

    def test_non_root_configuration_uses_non_interactive_sudo(self):
        with patch.object(installer.os, "geteuid", return_value=1000), patch.object(installer, "run") as run:
            installer.configure_host_network()
        self.assertEqual(run.call_args.args[0][:3], ["sudo", "-n", sys.executable])
        self.assertEqual(run.call_args.args[0][-1], "configure-network")

    def test_launcher_keeps_network_controller_when_application_is_rolled_back(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "releases" / ("a" * 40)
            target.mkdir(parents=True)
            old = root / "releases" / ("b" * 40)
            old.mkdir()
            (old / "getexception.py").write_text("# old controller without network policy")
            arguments = ["getexception.py", "install", "--release", target.name, "--install-dir", str(root), "--skip-start"]
            with patch.object(sys, "argv", arguments), patch.object(installer, "prerequisites"), patch.object(installer, "fetch_release", return_value=target), patch.object(installer, "configure", return_value={}):
                installer.main()
            controller = root / "runtime/controller.py"
            original = controller.read_bytes()
            installer.Installation(root).switch(old)
            self.assertEqual(controller.read_bytes(), original)
            self.assertIn('"$root/runtime/controller.py"', (root / "getexception").read_text())
            self.assertNotIn('"$root/current/getexception.py"', (root / "getexception").read_text())
