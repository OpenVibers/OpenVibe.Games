#!/usr/bin/env bash
set -euo pipefail
say() { echo "[openvibe] $*"; }
ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
cd "$ROOT"
WORKFLOW="${OPENVIBE_WORKFLOW:-windows-source-sdk-dlls.yml}"
BRANCH="${OPENVIBE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
REPO="${OPENVIBE_REPO:-$(tools/openvibe-gh-repo.sh)}"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI gh is missing. Install/auth it first: sudo apt install gh && gh auth login" >&2
  exit 1
fi

gh auth status >/dev/null
say "repo=$REPO"
say "workflow=$WORKFLOW"
say "branch=$BRANCH"

git push
say "triggering workflow"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH" -f diagnostics=1

say "waiting for new run to appear"
sleep 8
RUN_ID="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')"
say "watching run $RUN_ID"
if gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  say "workflow passed"
else
  warn_msg="workflow failed; downloading diagnostics anyway"
  echo "[openvibe warn] $warn_msg" >&2
fi

tools/windows-workflow-debug-and-install.sh "$RUN_ID" || true
