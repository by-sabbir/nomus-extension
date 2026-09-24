#!/usr/bin/env bash
# Build the Chrome Web Store upload zip from extension/ (tests excluded).
set -euo pipefail
cd "$(dirname "$0")/../extension"
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="../dist/nomus-extension-$version.zip"
mkdir -p ../dist && rm -f "$out"
zip -qrX "$out" . -x 'tests/*' -x '*.DS_Store'
echo "$out"
