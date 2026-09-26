#!/bin/sh
# Builds "Claude IDE.app" (macOS arm64) from vscode-fork with all Claude IDE patches applied.
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
"$ROOT/apply-fork.sh"
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
export NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=5000"
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
(cd "$ROOT/vscode-fork" && npm run gulp vscode-darwin-arm64)
APP="$ROOT/VSCode-darwin-arm64/Claude IDE.app"
# Sign the bundle (ad-hoc) so macOS knows it as "Claude IDE" and can grant it microphone access.
codesign --force --deep --sign - "$APP"
echo "Built $APP"
