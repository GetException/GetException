"""Publish a prerelease; an existing asset must match byte for byte."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

sha = os.environ["RELEASE_SHA"]
if not re.fullmatch(r"[a-f0-9]{40}", sha):
    raise RuntimeError("Invalid release SHA")
tag = "deploy-" + sha
repository = "GetException/GetException"
args = ["gh", "release", "view", tag, "--repo", repository, "--json", "targetCommitish,assets"]
found = subprocess.run(args, capture_output=True, text=True)
if found.returncode:
    # Creation fails if an existing release was temporarily unavailable; never overwrite it.
    subprocess.run(["gh", "release", "create", tag, "--repo", repository, "--target", sha, "--prerelease",
                    "--title", "GetException " + sha[:12], "--notes-file", "docs/release-notes.md"], check=True)
    present = set()
else:
    release = json.loads(found.stdout)
    if release["targetCommitish"] != sha:
        raise RuntimeError("Existing release points to a different commit")
    present = {asset["name"] for asset in release["assets"]}
for path in sorted(Path(".artifacts/release").iterdir()):
    if path.name in present:
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(["gh", "release", "download", tag, "--repo", repository,
                            "--pattern", path.name, "--dir", directory], check=True)
            if (Path(directory) / path.name).read_bytes() != path.read_bytes():
                raise RuntimeError("An immutable release asset already has different contents")
    else:
        subprocess.run(["gh", "release", "upload", tag, str(path), "--repo", repository], check=True)
