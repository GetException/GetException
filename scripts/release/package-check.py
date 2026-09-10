import argparse
import tarfile
from pathlib import Path


def package_files(path):
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        allowed = {"package/package.json", "package/LICENSE", "package/README.md", "package/THIRD-PARTY-NOTICES.md",
                   "package/dist/index.js", "package/dist/index.d.ts"}
        if len(members) != len(allowed) or {item.name for item in members} != allowed:
            raise RuntimeError("Unexpected files in the published SDK")
        if any(not item.isfile() or item.size > 5_000_000 for item in members):
            raise RuntimeError("Invalid SDK archive member")
        return {item.name: archive.extractfile(item).read() for item in members}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Validate SDK contents before publication and compare published packages.")
    parser.add_argument("name", choices=["browser", "react"])
    parser.add_argument("--archive", type=Path, help="Validate a local archive before publication")
    options = parser.parse_args()
    name = options.name
    directory = Path(".artifacts/registry")
    if options.archive:
        package_files(options.archive)
    elif package_files(directory / (name + ".tgz")) != package_files(directory / (name + "-expected.tgz")):
        raise RuntimeError("An existing npm version has different content; never overwrite or skip it")
