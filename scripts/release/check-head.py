"""Reject a release if stable changed after its checks started."""
import os
import re
import subprocess
import sys

from prepare import prepared_source

sha = os.environ["GITHUB_SHA"]
if not re.fullmatch(r"[a-f0-9]{40}", sha):
    raise RuntimeError("Invalid workflow source SHA")
if os.environ.get("GITHUB_REF") != "refs/heads/stable" or os.environ.get("REQUESTED_SHA", sha) != sha:
    raise RuntimeError("Release must run on the requested stable commit")
remote = subprocess.check_output(["git", "ls-remote", "origin", "refs/heads/stable"], text=True).split()[0]
if remote != sha:
    raise RuntimeError("stable advanced; refusing to publish or deploy an outdated release")
if "--prepared" in sys.argv and not prepared_source(sha):
    raise RuntimeError("Prepare a version commit before releasing")
