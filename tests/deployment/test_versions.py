import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class VersionPreparationTests(unittest.TestCase):
    def test_yarn_bumps_both_sdks_from_a_detached_stable_checkout_in_ci(self):
        env = {**os.environ, "CI": "true", "GITHUB_ACTIONS": "true", "GITHUB_REF": "refs/heads/stable"}
        for key in ["GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "YARN_NPM_AUTH_TOKEN"]:
            env.pop(key, None)
        with tempfile.TemporaryDirectory(prefix="getexception-version-test-") as directory:
            root = Path(directory)
            manager = json.loads((ROOT / "package.json").read_text())["packageManager"]
            (root / "package.json").write_text(json.dumps({"name": "@getexception/version-test", "private": True,
                                                          "packageManager": manager, "workspaces": ["packages/*"]}))
            for name in ["browser", "react"]:
                path = root / "packages" / name
                path.mkdir(parents=True)
                (path / "package.json").write_text(json.dumps({"name": "@getexception/" + name, "version": "0.1.0"}))
            shutil.copyfile(ROOT / ".yarnrc.yml", root / ".yarnrc.yml")
            shutil.copyfile(ROOT / ".gitignore", root / ".gitignore")

            def run(*args):
                result = subprocess.run(args, cwd=root, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, (result.stdout + result.stderr)[-2000:])

            run("corepack", "yarn", "install", "--no-immutable", "--mode=skip-build")
            run("git", "init", "--quiet", "--template=", "--initial-branch=stable")
            run("git", "add", "package.json", ".yarnrc.yml", ".gitignore", "packages", "yarn.lock")
            # This is a minimal throwaway Git fixture, not a repository release commit.
            run("git", "-c", "user.name=Release Test", "-c", "user.email=release@example.test", "commit", "--quiet", "-m", "fixture")
            run("git", "checkout", "--detach", "HEAD")
            for name in ["browser", "react"]:
                run("corepack", "yarn", "workspace", "@getexception/" + name, "version", "0.1.1")
                self.assertEqual(json.loads((root / "packages" / name / "package.json").read_text())["version"], "0.1.1")
            run("corepack", "yarn", "install", "--immutable", "--mode=skip-build")


if __name__ == "__main__":
    unittest.main()
