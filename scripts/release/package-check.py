import sys
import tarfile
from pathlib import Path


def package_files(path):
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        allowed = {"package/package.json", "package/LICENSE", "package/THIRD-PARTY-NOTICES.md",
                   "package/dist/index.js", "package/dist/index.d.ts"}
        if len(members) != len(allowed) or {item.name for item in members} != allowed:
            raise RuntimeError("Unexpected files in the published SDK")
        if any(not item.isfile() or item.size > 5_000_000 for item in members):
            raise RuntimeError("Invalid SDK archive member")
        return {item.name: archive.extractfile(item).read() for item in members}


if __name__ == "__main__":
    name = sys.argv[1]
    if name not in ["browser", "react"]:
        raise RuntimeError("Unknown SDK")
    directory = Path(".artifacts/registry")
    if package_files(directory / (name + ".tgz")) != package_files(directory / (name + "-expected.tgz")):
        raise RuntimeError("An existing npm version has different content; never overwrite or skip it")
