"""Verify release proofs, then update an existing server without forwarding GitHub credentials."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

REPOSITORY = "GetException/GetException"
WORKFLOW = REPOSITORY + "/.github/workflows/release.yml"

# Only this transport adapter runs remotely. The installed controller owns signature
# verification, locking, backups and rollback.
REMOTE_UPDATE = '''import json, os, pathlib, re, subprocess, sys, tempfile

def update(directory, sha, proofs):
    os.umask(0o077)
    root = pathlib.Path(directory)
    if not root.is_absolute() or not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise RuntimeError("Invalid deployment identity")
    if not (root / "getexception").is_file() or not (root / "runtime/.env").is_file():
        raise RuntimeError("An existing installation is required")
    expected = {"attestation.jsonl", "trusted-root.jsonl"}
    if set(proofs) != expected or any(not isinstance(value, str) or not 0 < len(value) <= 8000000 for value in proofs.values()):
        raise RuntimeError("Invalid release proof files")
    target = root / "runtime/deployments" / sha
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, content in proofs.items():
        fd, temporary = tempfile.mkstemp(dir=target)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(content)
            os.replace(temporary, target / name)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    command = [str(root / "getexception"), "update", "--release", sha, "--require-ingestion-smoke",
               "--attestation-bundle", str(target / "attestation.jsonl"),
               "--trusted-root", str(target / "trusted-root.jsonl")]
    return subprocess.run(command, check=False).returncode

if __name__ == "__main__":
    sys.exit(update(sys.argv[1], sys.argv[2], json.load(sys.stdin)))
'''


def parameters(env):
    host, user = env["DEPLOY_HOST"], env["DEPLOY_USER"]
    port = env.get("DEPLOY_PORT") or "22"
    directory = env.get("DEPLOY_DIR") or "/opt/getexception"
    sha = env["RELEASE_SHA"]
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", host) or not re.fullmatch(r"[a-z_][a-z0-9_-]*", user):
        raise RuntimeError("Invalid SSH host or user")
    if not port.isdigit() or not 0 < int(port) < 65536 or not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise RuntimeError("Invalid port or release")
    if not directory.startswith("/") or any(ord(char) < 32 for char in directory):
        raise RuntimeError("Use an absolute installation path without control characters")
    if not env.get("DEPLOY_SSH_KEY", "").strip() or not env.get("DEPLOY_KNOWN_HOSTS", "").strip():
        raise RuntimeError("Configure SSH_KEY and the verified SSH_KNOWN_HOSTS")
    return host, user, port, directory, sha


def release_proofs(sha, temporary):
    archive = temporary / "getexception.tar.gz"
    subprocess.run(["gh", "release", "download", "deploy-" + sha, "--repo", REPOSITORY,
                    "--pattern", archive.name, "--pattern", archive.name + ".sha256",
                    "--dir", str(temporary)], check=True, timeout=120)
    expected = (temporary / (archive.name + ".sha256")).read_text().split()
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if expected != [digest, archive.name]:
        raise RuntimeError("Release checksum verification failed before SSH")
    subprocess.run(["gh", "attestation", "download", str(archive), "--repo", REPOSITORY],
                   cwd=temporary, check=True, timeout=120)
    bundle = temporary / ("sha256:" + digest + ".jsonl")
    trusted_root = temporary / "trusted-root.jsonl"
    with trusted_root.open("w") as stream:
        subprocess.run(["gh", "attestation", "trusted-root"], stdout=stream, check=True, timeout=120)
    subprocess.run(["gh", "attestation", "verify", str(archive), "--repo", REPOSITORY,
                    "--signer-workflow", WORKFLOW, "--source-ref", "refs/heads/stable",
                    "--source-digest", sha, "--bundle", str(bundle),
                    "--custom-trusted-root", str(trusted_root)], check=True, timeout=120)
    return {"attestation.jsonl": bundle.read_text(), "trusted-root.jsonl": trusted_root.read_text()}


def deploy(env):
    host, user, port, directory, sha = parameters(env)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="getexception-ssh-") as temporary:
        temporary = Path(temporary)
        proofs = release_proofs(sha, temporary)
        key, hosts = temporary / "key", temporary / "known_hosts"
        key.write_text(env["DEPLOY_SSH_KEY"] + "\n")
        hosts.write_text(env["DEPLOY_KNOWN_HOSTS"] + "\n")
        command = shlex.join(["python3", "-c", REMOTE_UPDATE, directory, sha])
        subprocess.run(["ssh", "-i", str(key), "-p", port, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                        "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + str(hosts),
                        "-o", "ConnectTimeout=15", user + "@" + host, command],
                       input=json.dumps(proofs), text=True, check=True, timeout=1000,
                       env={key: value for key, value in env.items()
                            if key not in ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN",
                                           "YARN_NPM_AUTH_TOKEN", "DEPLOY_SSH_KEY"]})


if __name__ == "__main__":
    deploy(os.environ)
