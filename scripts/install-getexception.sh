#!/usr/bin/env bash
set -euo pipefail
umask 077

# This small bootstrap must itself be checksum/attestation verified before execution.
release=""
args=("$@")
while (($#)); do
  case "$1" in
    --release) release="${2:?Missing release SHA}"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ ! "$release" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Usage: bash install-getexception.sh --release <40-character SHA> [installer options]" >&2
  exit 1
fi
for tool in curl gh python3 docker; do
  command -v "$tool" >/dev/null || { echo "Install $tool first; see docs/deployment.md." >&2; exit 1; }
done
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
base="https://github.com/GetException/GetException/releases/download/deploy-$release"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-time 120 "$base/getexception.py" --output "$temporary/getexception.py"
gh attestation verify "$temporary/getexception.py" --repo GetException/GetException \
  --signer-workflow GetException/GetException/.github/workflows/release.yml \
  --source-ref refs/heads/stable --source-digest "$release" >/dev/null
python3 "$temporary/getexception.py" install "${args[@]}"
