"""Scan the exact upstream images deployed by Compose, without a Docker daemon."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
references = re.findall(r"^\s+image: ((?:postgres|caddy):\S+)$", (ROOT / "deploy/compose.yaml").read_text(), re.M)
if len(references) != 2 or any(not re.fullmatch(r"(?:postgres|caddy):[\w.-]+@sha256:[a-f0-9]{64}", image) for image in references):
    raise RuntimeError("Both infrastructure images must have immutable references")
failed = False
for reference in references:
    name = reference.split(":", 1)[0]
    result = subprocess.run([str(ROOT / ".artifacts/tools/grype"), "registry:" + reference,
                             "--platform", "linux/amd64", "--fail-on", "high", "--output", "json",
                             "--file", str(ROOT / (".artifacts/grype-" + name + ".json"))], timeout=900)
    failed = failed or result.returncode != 0
if failed:
    raise SystemExit("Infrastructure image scan failed; review both reports before release")
