#!/bin/sh
# Builds "Claude IDE.app" (macOS, Apple silicon) with all Claude IDE patches applied.
# First run downloads the pinned VS Code (Code - OSS) source into vscode-fork/ and installs dependencies.
# Usage: ./build-app.sh
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
FORK="$ROOT/vscode-fork"
# The patches in fork-patches/ and apply-fork.sh target this exact Code - OSS version (1.140.0).
VSCODE_COMMIT=ca1020a2710357004a97608f712a937968a3c433

# Code - OSS 1.140 needs Node 24.
if [ "$(node -v 2>/dev/null | cut -d. -f1)" != "v24" ]; then
  if [ -x /opt/homebrew/opt/node@24/bin/node ]; then export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
  else echo "Node 24 is required: brew install node@24" >&2; exit 1; fi
fi
# Avoid slow IPv6 fallbacks on some networks when downloading dependencies.
export NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=5000"

if [ ! -d "$FORK/.git" ]; then
  echo "Downloading Code - OSS ($VSCODE_COMMIT)…"
  git init -q "$FORK"
  git -C "$FORK" remote add origin https://github.com/microsoft/vscode.git
  # Skip Git LFS files (only test fixtures) so the checkout works with or without git-lfs installed.
  GIT_LFS_SKIP_SMUDGE=1 git -C "$FORK" fetch --depth 1 origin "$VSCODE_COMMIT"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$FORK" -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false checkout -q FETCH_HEAD
fi

[ -d "$ROOT/claude-agent/node_modules" ] || (cd "$ROOT/claude-agent" && npm ci)
"$ROOT/apply-fork.sh" "$FORK"                       # must run before npm ci (it disables a download that fails outside Microsoft)
[ -d "$FORK/node_modules" ] || (cd "$FORK" && npm ci)
(cd "$FORK" && npm run gulp vscode-darwin-arm64-min)

APP="$ROOT/VSCode-darwin-arm64/Claude IDE.app"
RES="$APP/Contents/Resources/app"
# Drop Microsoft's Copilot pieces (disabled in Claude IDE): ~500 MB. Remove their integrity checksums too.
rm -rf "$RES/extensions/copilot" "$RES/out/vs/sessions" "$RES/node_modules.asar.unpacked/@github/copilot-sdk-darwin-arm64"
node -e "const f=process.argv[1],p=require(f);for(const k of Object.keys(p.checksums||{}))if(k.startsWith('vs/sessions/'))delete p.checksums[k];require('fs').writeFileSync(f,JSON.stringify(p,null,'\t'))" "$RES/product.json"
touch "$APP"                                          # the build stamps files with 1980; give the app today's date
# Sign the bundle (ad-hoc) so macOS knows it as "Claude IDE" and can grant it microphone access.
codesign --force --deep --sign - "$APP"
echo "Built $APP"
