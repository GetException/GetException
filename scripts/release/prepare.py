#!/usr/bin/env python3
"""Create/reuse one release commit, then dispatch the release at that exact commit."""
import json
import os
from pathlib import Path
import re
import subprocess


def run(*args):
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode:
        detail = result.stdout + result.stderr
        for key in ["GH_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "YARN_NPM_AUTH_TOKEN"]:
            token = os.environ.get(key)
            if token:
                detail = detail.replace(token, "[REDACTED]")
        raise RuntimeError(f"Release command {args[0]} exited with {result.returncode}: {detail[-3000:]}")
    return result.stdout.strip()


def prepare(source):
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise RuntimeError("Invalid source SHA")
    run("git", "fetch", "origin", "stable")
    remote = run("git", "rev-parse", "origin/stable")
    marker = "Release-Source: " + source
    message = run("git", "log", "-1", "--format=%B", remote)
    if remote != source:
        if marker not in message.splitlines() or run("git", "rev-parse", remote + "^") != source:
            raise RuntimeError("stable advanced; refusing to release outdated code")
        run("git", "checkout", "--detach", remote)
        return remote
    run("git", "checkout", "--detach", source)
    manifests = [Path("packages") / name / "package.json" for name in ["browser", "react"]]
    versions = [json.loads(path.read_text())["version"] for path in manifests]
    if versions[0] != versions[1] or not re.fullmatch(r"\d+\.\d+\.\d+", versions[0]):
        raise RuntimeError("SDK versions must be aligned stable semver versions")
    major, minor, patch = map(int, versions[0].split("."))
    version = f"{major}.{minor}.{patch + 1}"
    for name in ["browser", "react"]:
        run("corepack", "yarn", "workspace", "@getexception/" + name, "version", version)
    run("corepack", "yarn", "install", "--no-immutable", "--mode=update-lockfile")
    run("corepack", "yarn", "format")
    # Required before EVERY commit, including the automated release commit.
    subprocess.run(["corepack", "yarn", "checks"], check=True)
    run("git", "add", "packages/browser/package.json", "packages/react/package.json", "yarn.lock")
    run("git", "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit", "-m", "chore: release SDK " + version + " [skip ci]", "-m", marker)
    sha = run("git", "rev-parse", "HEAD")
    changed = set(run("git", "diff", "--name-only", source + ".." + sha).splitlines())
    if not changed <= {str(path) for path in manifests} | {"yarn.lock"}:
        raise RuntimeError("Unexpected files in the automated release commit")
    run(str(Path(".artifacts/tools/gitleaks").resolve()), "git", "--log-opts=" + source + ".." + sha, "--redact", "--no-banner")
    # A concurrent push fails normally; no force push and no stale release.
    run("git", "push", "origin", "HEAD:stable")
    return sha


if __name__ == "__main__":
    sha = prepare(os.environ["SOURCE_SHA"])
    run("git", "fetch", "origin", "stable")
    if run("git", "rev-parse", "origin/stable") != sha:
        raise RuntimeError("stable changed before dispatch")
    # A separate dispatch gives provenance the release commit as GITHUB_SHA.
    run("gh", "workflow", "run", "release.yml", "--ref", "stable", "-f", "release_sha=" + sha)
    print("Release prepared and dispatched: " + sha)
