#!/usr/bin/env python3
"""Create an allow-listed bootstrap bundle from a previously built image manifest."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy"))
from getexception import FILES, REPOSITORY, metadata


def build_bundle(sha, images, output):
    root = Path(__file__).resolve().parents[2]
    output.mkdir(parents=True, exist_ok=True)
    policy = json.loads((root / "deploy/release-policy.json").read_text())
    manifest = {"repository": REPOSITORY, "sha": sha, "images": images, **policy}
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        for name in FILES - {"release.json", "init-db.sh"}:
            shutil.copyfile(root / "deploy" / name, directory / name)
        shutil.copyfile(root / "docker/init-db.sh", directory / "init-db.sh")
        (directory / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")
        metadata(directory, sha)
        archive = output / "getexception.tar.gz"
        with archive.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w") as bundle:
            for name in sorted(FILES):
                info = bundle.gettarinfo(str(directory / name), arcname=name)
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                info.mode = 0o644
                with (directory / name).open("rb") as stream:
                    bundle.addfile(info, stream)
        shutil.copyfile(root / "scripts/install-getexception.sh", output / "install-getexception.sh")
        shutil.copyfile(root / "deploy/getexception.py", output / "getexception.py")
        for name in ["getexception.tar.gz", "install-getexception.sh", "getexception.py"]:
            digest = hashlib.sha256((output / name).read_bytes()).hexdigest()
            (output / (name + ".sha256")).write_text(digest + "  " + name + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--images", required=True)
    parser.add_argument("--output", default=".artifacts/release")
    args = parser.parse_args()
    build_bundle(args.sha, json.loads(Path(args.images).read_text()), Path(args.output))
