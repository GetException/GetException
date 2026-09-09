"""Reuse a previously published SHA tag, and fail closed on registry/auth errors."""
import json
import os
import re
import subprocess
import urllib.error
import urllib.request


def existing_digest(target, sha, token):
    if target not in ["web", "ingest", "worker", "mail", "migrate"] or not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise RuntimeError("Invalid image identity")
    # GHCR can return DENIED before a package's first publication. Distinguish this
    # from a failed lookup of an existing package using the authenticated Packages API.
    request = urllib.request.Request("https://api.github.com/orgs/GetException/packages/container/getexception-" + target,
                                     headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(request, timeout=30):
            pass
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise RuntimeError("Cannot verify existing GHCR package access") from None
    reference = "ghcr.io/getexception/getexception-" + target + ":sha-" + sha
    result = subprocess.run(["docker", "buildx", "imagetools", "inspect", reference, "--format", "{{json .Manifest}}"],
                            text=True, capture_output=True)
    if result.returncode:
        if not any(text in result.stderr.lower() for text in ["not found", "manifest unknown"]):
            raise RuntimeError("Registry unavailable; refusing to rebuild an uncertain existing SHA")
        return None
    digest = json.loads(result.stdout)["digest"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise RuntimeError("Registry returned an invalid digest")
    return digest


if __name__ == "__main__":
    digest = existing_digest(os.environ["TARGET"], os.environ["RELEASE_SHA"], os.environ["GH_TOKEN"])
    if digest:
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write("digest=" + digest + "\n")
