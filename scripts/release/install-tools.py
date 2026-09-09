"""Download only explicitly pinned tools, verify SHA256 before extracting a binary."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile

pins = json.loads(Path("scripts/release/tools.json").read_text())
directory = Path(".artifacts/tools").resolve()
directory.mkdir(parents=True, exist_ok=True)
if platform.machine() not in ["x86_64", "amd64"]:
    raise RuntimeError("Tool pins currently cover amd64; install actionlint/gitleaks from verified sources on other architectures")
for name in sys.argv[1:] or ["actionlint", "gitleaks"]:
    pin = pins[name]
    arch, expected = pin[sys.platform]
    filename = f"{name}_{pin['version']}_{sys.platform}_{arch}.tar.gz"
    url = f"https://github.com/{pin['repository']}/releases/download/v{pin['version']}/{filename}"
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary) / filename
        subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
                        "--proto-redir", "=https", "--max-time", "180", url, "-o", str(archive)], check=True)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise RuntimeError("Tool checksum failed: " + name)
        with tarfile.open(archive, "r:gz") as bundle:
            member = bundle.getmember(name)
            if not member.isfile() or member.size > 300_000_000:
                raise RuntimeError("Invalid tool binary")
            target = directory / (name + ".next")
            with bundle.extractfile(member) as source, target.open("wb") as output:
                import shutil
                shutil.copyfileobj(source, output)
        os.chmod(target, 0o700)
        os.replace(target, directory / name)
    print(name + " " + pin["version"] + " verified and installed.")
