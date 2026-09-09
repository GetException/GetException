"""Update an already installed server. This script never bootstraps or resets an account."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

os.umask(0o077)
host = os.environ["DEPLOY_HOST"]
user = os.environ["DEPLOY_USER"]
port = os.environ.get("DEPLOY_PORT") or "22"
directory = os.environ.get("DEPLOY_DIR") or "/opt/getexception"
sha = os.environ["RELEASE_SHA"]
if not re.fullmatch(r"[a-zA-Z0-9.-]+", host) or not re.fullmatch(r"[a-z_][a-z0-9_-]*", user):
    raise RuntimeError("Invalid SSH host or user")
if not port.isdigit() or not 0 < int(port) < 65536 or not re.fullmatch(r"[a-f0-9]{40}", sha):
    raise RuntimeError("Invalid port or release")
if not directory.startswith("/") or "\n" in directory:
    raise RuntimeError("Use an absolute installation path")
with tempfile.TemporaryDirectory(prefix="getexception-ssh-") as temporary:
    key = Path(temporary) / "key"
    hosts = Path(temporary) / "known_hosts"
    key.write_text(os.environ["DEPLOY_SSH_KEY"] + "\n")
    hosts.write_text(os.environ["DEPLOY_KNOWN_HOSTS"] + "\n")
    command = shlex.join([directory + "/getexception", "update", "--release", sha, "--require-ingestion-smoke"])
    subprocess.run(["ssh", "-i", str(key), "-p", port, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                    "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + str(hosts),
                    "-o", "ConnectTimeout=15", user + "@" + host, command], check=True, timeout=1000)
