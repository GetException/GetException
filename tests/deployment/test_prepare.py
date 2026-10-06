"""Exercise version commits and retries against a real, isolated Git remote."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[2] / "scripts/release/prepare.py"
spec = importlib.util.spec_from_file_location("prepare_sdk", path)
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PrepareReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="getexception-release-test-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.repo = root / "work"
        self.repo.mkdir()
        self.original_directory = Path.cwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, self.original_directory)
        self.git("init", "--bare", "--initial-branch=stable", str(root / "remote.git"))
        self.git("init", "--initial-branch=stable")
        self.git("config", "user.name", "Release test")
        self.git("config", "user.email", "release@example.com")
        self.git("config", "commit.gpgsign", "false")
        self.git("remote", "add", "origin", str(root / "remote.git"))
        for name in ["browser", "react", "cli"]:
            manifest = Path("packages") / name / "package.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({"name": "@getexception/" + name, "version": "0.1.1"}))
        Path("yarn.lock").write_text("initial test lockfile\n")
        self.git("add", ".")
        self.git("commit", "-m", "Initial source")
        self.git("push", "origin", "stable")
        self.source = self.git("rev-parse", "HEAD")
        self.real_run = prepare.run
        self.commands = []

    def git(self, *args):
        return subprocess.check_output(["git", *args], text=True, stderr=subprocess.PIPE).strip()

    def command(self, *args):
        self.commands.append(args)
        if args[0] == "corepack":
            if "workspace" in args:
                name, operation, version = args[3:]
                self.assertEqual(operation, "version")
                manifest = Path("packages") / name.split("/")[1] / "package.json"
                values = json.loads(manifest.read_text())
                values["version"] = version
                manifest.write_text(json.dumps(values))
            elif "install" in args:
                Path("yarn.lock").write_text("updated test lockfile\n")
            return ""
        if Path(args[0]).name == "gitleaks":
            return ""
        return self.real_run(*args)

    def prepare(self, checks=None):
        # Package operations and checks are isolated; commits, fetches and pushes use real Git.
        checks = checks or (lambda *args, **kwargs: None)
        with patch.object(prepare, "run", side_effect=self.command), patch.object(prepare, "subprocess") as process:
            process.run.side_effect = lambda args, **kwargs: (
                checks(args, **kwargs) if args[:3] == ["corepack", "yarn", "checks"]
                else subprocess.run(args, **kwargs)
            )
            return prepare.prepare(self.source)

    def test_publishes_one_version_commit_and_reuses_it_on_retry(self):
        verified = []

        def checks(*args, **kwargs):
            self.assertEqual(self.git("rev-parse", "HEAD"), self.source)
            verified.append(True)

        released = self.prepare(checks)
        self.assertEqual(verified, [True])
        self.assertEqual(self.git("rev-parse", "origin/stable"), released)
        self.assertEqual(self.git("rev-parse", released + "^"), self.source)
        self.assertEqual(set(self.git("diff", "--name-only", self.source, released).splitlines()), {
            "packages/browser/package.json", "packages/react/package.json", "packages/cli/package.json", "yarn.lock",
        })
        for name in ["browser", "react", "cli"]:
            self.assertEqual(json.loads((Path("packages") / name / "package.json").read_text())["version"], "0.1.2")
        message = self.git("log", "-1", "--format=%B")
        self.assertIn("[skip ci]", message)
        self.assertIn("Release-Source: " + self.source, message)
        scan = next(index for index, command in enumerate(self.commands) if Path(command[0]).name == "gitleaks")
        push = next(index for index, command in enumerate(self.commands) if command[:2] == ("git", "push"))
        self.assertLess(scan, push)
        self.assertIn("--log-opts=" + self.source + ".." + released, self.commands[scan])
        self.commands.clear()
        self.assertEqual(self.prepare(), released)
        self.assertFalse(any(command[0] == "corepack" for command in self.commands))
        self.assertEqual(self.git("rev-list", "--count", "stable..origin/stable"), "1")

    def test_failed_checks_prevent_commit_and_push(self):
        def checks(*args, **kwargs):
            raise subprocess.CalledProcessError(1, ["corepack", "yarn", "checks"])

        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare(checks)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.source)
        self.assertEqual(self.git("rev-parse", "origin/stable"), self.source)

    def test_manual_retry_on_prepared_stable_keeps_the_same_version(self):
        released = self.prepare()
        self.source = released
        self.commands.clear()
        self.assertEqual(self.prepare(), released)
        self.assertFalse(any(command[0] == "corepack" for command in self.commands))

    def test_server_fix_preserves_sdk_version_and_has_an_empty_prepared_commit(self):
        previous = self.prepare()
        self.git("checkout", "-B", "stable", previous)
        Path("server.py").write_text("server change\n")
        self.git("add", "server.py")
        self.git("commit", "-m", "Fix server")
        self.git("push", "origin", "stable")
        self.source = self.git("rev-parse", "HEAD")
        self.commands.clear()
        checks = []
        released = self.prepare(lambda *args, **kwargs: checks.append(True))
        self.assertEqual(checks, [True])
        self.assertEqual(prepare.prepared_source(released), self.source)
        self.assertEqual(self.git("diff", "--name-only", self.source, released), "")
        self.assertFalse(any("workspace" in command for command in self.commands))
        for name in ["browser", "react", "cli"]:
            self.assertEqual(json.loads((Path("packages") / name / "package.json").read_text())["version"], "0.1.2")

    def test_sdk_protocol_or_build_inputs_still_bump_the_sdk(self):
        for filename in ["packages/browser/src/index.ts", "packages/protocol/src/event.ts", "scripts/build.ts"]:
            with self.subTest(filename=filename):
                previous = self.prepare()
                self.git("checkout", "-B", "stable", previous)
                target = Path(filename)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("input change\n")
                self.git("add", filename)
                self.git("commit", "-m", "Change SDK input")
                self.git("push", "origin", "stable")
                self.source = self.git("rev-parse", "HEAD")
                self.assertTrue(prepare.sdk_changed(self.source))
                before = json.loads((Path("packages/browser/package.json")).read_text())["version"]
                self.prepare()
                expected = "0.1." + str(int(before.split(".")[2]) + 1)
                self.assertEqual(json.loads((Path("packages/browser/package.json")).read_text())["version"], expected)

    def test_server_preparation_cannot_include_unreviewed_file_changes(self):
        previous = self.prepare()
        self.git("checkout", "-B", "stable", previous)
        Path("server.py").write_text("server change\n")
        self.git("add", "server.py")
        self.git("commit", "-m", "Fix server")
        self.git("push", "origin", "stable")
        self.source = self.git("rev-parse", "HEAD")
        self.prepare()
        Path("unexpected.txt").write_text("not a preparation change")
        self.git("add", "unexpected.txt")
        self.git("commit", "--amend", "--no-edit")
        with self.assertRaisesRegex(RuntimeError, "Unexpected files"):
            prepare.prepared_source(self.git("rev-parse", "HEAD"))

    def test_extra_changes_cannot_masquerade_as_a_release_commit(self):
        self.prepare()
        Path("unexpected.txt").write_text("not a version change")
        self.git("add", "unexpected.txt")
        self.git("commit", "--amend", "--no-edit")
        with self.assertRaisesRegex(RuntimeError, "Unexpected files"):
            prepare.prepared_source(self.git("rev-parse", "HEAD"))

    def test_release_guard_rejects_unprepared_or_stale_or_wrong_branch(self):
        guard = path.with_name("check-head.py")

        def check(sha, branch="refs/heads/stable"):
            return subprocess.run(["python3", str(guard), "--prepared"], capture_output=True,
                                  env={**os.environ, "GITHUB_SHA": sha, "GITHUB_REF": branch,
                                       "REQUESTED_SHA": sha}).returncode

        self.assertNotEqual(check(self.source), 0)
        released = self.prepare()
        self.assertEqual(check(released), 0)
        self.assertNotEqual(check(released, "refs/heads/feature"), 0)
        self.assertNotEqual(check(self.source), 0)

    def test_unrelated_remote_commit_prevents_version_bump(self):
        Path("new-work.txt").write_text("another developer's change\n")
        self.git("add", "new-work.txt")
        self.git("commit", "-m", "Other work")
        self.git("push", "origin", "stable")
        with self.assertRaisesRegex(RuntimeError, "stable advanced"):
            self.prepare()
        self.assertFalse(any(command[0] == "corepack" for command in self.commands))
