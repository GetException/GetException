"""Reject a release if stable changed after its checks started."""
import os
import re
import subprocess

sha = os.environ["GITHUB_SHA"]
if not re.fullmatch(r"[a-f0-9]{40}", sha):
    raise RuntimeError("Invalid workflow source SHA")
remote = subprocess.check_output(["git", "ls-remote", "origin", "refs/heads/stable"], text=True).split()[0]
if remote != sha:
    raise RuntimeError("stable advanced; refusing to publish or deploy an outdated release")
