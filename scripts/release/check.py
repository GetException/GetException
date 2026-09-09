"""Offline release checks, with mandatory Docker validation on Linux CI."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy"))
from getexception import SECRET_KEYS, env_text


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


run("python3", "-m", "unittest", "discover", "-s", "tests/deployment", "-p", "test_*.py")
for path in ["scripts/install-getexception.sh", "scripts/release/install-browser.sh", "docker/init-db.sh"]:
    run("bash", "-n", path)
for path in Path(".github/workflows").glob("*.yml"):
    for action in re.findall(r"uses:\s*([^\s]+)", path.read_text()):
        if not action.startswith("./") and not re.fullmatch(r"[\w./-]+@[a-f0-9]{40}", action):
            raise RuntimeError("Unpinned GitHub Action: " + str(path))

actionlint = str(ROOT / ".artifacts/tools/actionlint")
if not Path(actionlint).exists():
    actionlint = shutil.which("actionlint")
if not actionlint:
    raise RuntimeError("Run yarn ci:tools to install verified actionlint and gitleaks")
run(actionlint, "-color", "-shellcheck=", *map(str, Path(".github/workflows").glob("*.yml")))

gitleaks = ROOT / ".artifacts/tools/gitleaks"
if not gitleaks.exists():
    raise RuntimeError("Run yarn ci:tools before yarn checks")
# Scan the reviewable source tree, including untracked work, without copying local secrets/runtime.
paths = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "-z"]).decode().split("\0")
with tempfile.TemporaryDirectory(prefix="getexception-secret-scan-") as temporary:
    for name in set(paths) - {""}:
        path = Path(name)
        if path.is_file() and not path.is_symlink():
            if path.name == ".npmrc" or (path.name.startswith(".env") and path.name != ".env.example"):
                raise RuntimeError("Secret configuration is present in the Git source set")
            target = Path(temporary) / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    run(str(gitleaks), "dir", temporary, "--redact", "--no-banner")

# Validate third-party package declarations offline; platform-specific native packages are included.
allowed = {"MIT", "MIT-0", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense",
           "BlueOak-1.0.0", "Python-2.0", "CC-BY-4.0", "MPL-2.0", "EPL-2.0", "MIT and ISC", "LGPL-3.0-or-later"}
for directory, folders, files in os.walk("node_modules"):
    folders[:] = [name for name in folders if name not in [".cache", ".bin", ".vite"]]
    if "package.json" not in files:
        continue
    manifest = json.loads((Path(directory) / "package.json").read_text())
    if not manifest.get("name") or not manifest.get("version"):
        continue
    license_id = manifest.get("license")
    if isinstance(license_id, dict):
        license_id = license_id.get("type")
    if manifest["name"] == "seq-queue" and manifest["version"] == "0.0.5":
        if "Permission is hereby granted, free of charge" in (Path(directory) / "LICENSE").read_text():
            license_id = "MIT"
    if license_id not in allowed:
        raise RuntimeError("Review dependency license: " + manifest["name"] + " " + str(license_id))

compose_command = ["docker", "compose"] if shutil.which("docker") else ([str(ROOT / ".artifacts/tools/docker-compose")] if (ROOT / ".artifacts/tools/docker-compose").exists() else None)
if compose_command:
    values = {key: "a" * 64 for key in SECRET_KEYS}
    values.update(SETUP_TOKEN_HASH="b" * 64, DASHBOARD_HOST="monitor.example.com", INGEST_HOST="ingest.example.com",
                  ACME_EMAIL="admin@example.com", SMTP_HOST="smtp.example.com", SMTP_FROM="monitor@example.com")
    values.update({name.upper() + "_IMAGE": "ghcr.io/getexception/getexception-" + name + ":validation"
                   for name in ["web", "ingest", "worker", "mail", "migrate"]})
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / ".env"
        path.write_text(env_text(values))
        for compose in ["compose.yaml", "deploy/compose.yaml"]:
            run(*compose_command, "--env-file", str(path), "-f", compose, "config", "--quiet")
elif os.environ.get("CI"):
    raise RuntimeError("Docker Compose validation is mandatory in CI")
else:
    print("Docker is absent: Compose execution is covered by the mandatory Linux CI job.")
print("Release policy, installer, workflows, source secrets and dependency licenses passed.")
