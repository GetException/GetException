"""Preserve the complete Grype report; assess only explicitly reviewed findings."""
import argparse
from datetime import date
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
TARGETS = {"web", "ingest", "worker", "migrate", "caddy", "postgres"}


def assessed(match, target, today):
    # CVE-2026-85091 requires the gzprintf/gzvprintf non-blocking file API.
    # Node's binding and PostgreSQL custom-format dumps use deflate/inflate.
    # See docs/image-security.md for the versioned source review and boundaries.
    artifact = match["artifact"]
    if today > date(2026, 11, 2) or target not in {"web", "ingest", "worker", "migrate", "postgres"}:
        return False
    return (match["vulnerability"]["id"] == "CVE-2026-85091"
            and artifact["name"] == "zlib" and artifact["version"] == "1.3.2-r0"
            and artifact["type"] == "apk"
            and artifact.get("purl", "").startswith("pkg:apk/alpine/zlib@1.3.2-r0?"))


def evaluate(report, target, today=None):
    today = today or date.today()
    if target not in TARGETS or not isinstance(report.get("matches"), list):
        raise ValueError("Missing or invalid image scan report")
    if report.get("ignoredMatches"):
        raise ValueError("External scanner exclusions are not allowed")
    blocking, reviewed = [], []
    for match in report["matches"]:
        severity = match["vulnerability"]["severity"]
        if severity in {"Critical", "High", "Unknown"}:
            (reviewed if assessed(match, target, today) else blocking).append(match)
    return blocking, reviewed


def scan(reference, target):
    if target not in TARGETS or not re.fullmatch(r"[a-z0-9./:_-]+@sha256:[a-f0-9]{64}", reference):
        raise ValueError("Image scan requires an immutable reference and known target")
    if target == "postgres":
        expected = "postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24"
        if reference != expected:
            raise ValueError("Review the PostgreSQL version before reusing the applicability assessment")
    elif not reference.startswith("ghcr.io/getexception/getexception-" + target + "@sha256:"):
        raise ValueError("Unexpected runtime image repository")
    if not (ROOT / "docker/Dockerfile").read_text().startswith("FROM node:24.21.0-alpine3.24@sha256:"):
        raise ValueError("Review the Node version before reusing the applicability assessment")
    report_path = ROOT / (".artifacts/grype-" + target + ".json")
    report_path.parent.mkdir(exist_ok=True)
    report_path.unlink(missing_ok=True)
    result = subprocess.run([str(ROOT / ".artifacts/tools/grype"), "registry:" + reference,
                             "--platform", "linux/amd64", "--fail-on", "high", "--output", "json",
                             "--file", str(report_path)], timeout=900)
    if result.returncode not in {0, 2} or not report_path.is_file():
        raise RuntimeError("Image scanner failed; release blocked")
    report = json.loads(report_path.read_text())
    blocking, reviewed = evaluate(report, target)
    summary = {"image": reference, "blocking": len(blocking), "reviewedNotApplicable": len(reviewed),
               "reviewExpires": "2026-11-02" if reviewed else None}
    (ROOT / (".artifacts/grype-" + target + "-assessment.json")).write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"target": target, **summary}))
    if blocking:
        raise RuntimeError("Unassessed High/Critical/Unknown findings block this release")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--target", choices=sorted(TARGETS), required=True)
    options = parser.parse_args()
    scan(options.image, options.target)
