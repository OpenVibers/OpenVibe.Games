#!/usr/bin/env bash
set -euo pipefail
url="${1:-$(git config --get remote.origin.url)}"
url="${url#git@github.com:}"
url="${url#ssh://git@github.com/}"
url="${url#https://github.com/}"
url="${url#http://github.com/}"
url="${url%.git}"
url="${url%/}"
if [[ ! "$url" =~ ^[^/]+/[^/]+$ ]]; then
  echo "Could not normalize GitHub repo from remote.origin.url: ${url}" >&2
  exit 1
fi
echo "$url"
