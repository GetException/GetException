#!/usr/bin/env bash
set -euo pipefail

# Playwright downloads its own Chromium. The hosted runner's unrelated Google
# Chrome APT feed can have inconsistent indexes and break dependency installation.
if [[ "${GITHUB_ACTIONS:-}" == "true" && "${RUNNER_ENVIRONMENT:-}" == "github-hosted" && "${RUNNER_OS:-}" == "Linux" ]]; then
  for source in /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google-chrome.sources; do
    if [[ -f "$source" ]]; then
      sudo mv "$source" "$source.getexception-disabled"
    fi
  done
fi

exec corepack yarn playwright install --with-deps chromium
