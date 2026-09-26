#!/bin/sh
# Applies Claude IDE branding + built-in extension onto a Code - OSS checkout. Re-run after pulling upstream.
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
FORK=${1:-$ROOT/vscode-fork}
EXT=$ROOT/claude-agent

(cd "$EXT" && npm run build)

# 1. Branding: Claude IDE (no Microsoft names/marketplace; Open VSX like VSCodium)
node - "$FORK/product.json" <<'JS'
const fs = require('fs'), f = process.argv[2], p = JSON.parse(fs.readFileSync(f, 'utf8'));
Object.assign(p, {
  nameShort: 'Claude IDE', nameLong: 'Claude IDE', applicationName: 'claude-ide',
  dataFolderName: '.claude-ide', sharedDataFolderName: '.claude-ide-shared',
  serverApplicationName: 'claude-ide-server', serverDataFolderName: '.claude-ide-server', tunnelApplicationName: 'claude-ide-tunnel',
  darwinBundleIdentifier: 'dev.local.claude-ide', linuxDesktopName: 'dev.local.ClaudeIDE', linuxIconName: 'claude-ide',
  urlProtocol: 'claude-ide', win32DirName: 'Claude IDE', win32NameVersion: 'Claude IDE', win32AppUserModelId: 'Local.ClaudeIDE', win32MutexName: 'claudeide',
  reportIssueUrl: undefined,
  extensionsGallery: {
    serviceUrl: 'https://open-vsx.org/vscode/gallery', itemUrl: 'https://open-vsx.org/vscode/item',
    extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest', resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
  },
});
fs.writeFileSync(f, JSON.stringify(p, null, '\t') + '\n');
JS

# 1a. Skip an optional Microsoft-internal download (on-device dictation runtime) that fails outside their network
sed -i '' 's/"foundry-local-sdk@\([0-9.]*\)": true/"foundry-local-sdk@\1": false/' "$FORK/package.json"

# 1b. Icon, editor watermark, default theme (assets from fork-patches/brand/make_brand.py)
cp "$ROOT/fork-patches/brand/claude-ide.icns" "$FORK/resources/darwin/code.icns"
cp "$ROOT"/fork-patches/brand/letterpress-*.svg "$FORK/src/vs/workbench/browser/parts/editor/media/"
sed -i '' "s/export const COLOR_THEME_DARK = '[^']*';/export const COLOR_THEME_DARK = 'Claude IDE Dark';/" "$FORK/src/vs/workbench/services/themes/common/workbenchThemeService.ts"

# 2. Default layout: secondary side bar (Claude panel) visible on the right
sed -i '' "/'workbench.secondarySideBar.defaultVisibility': {/,/'default':/ s/'default': 'visibleInWorkspace'/'default': 'visible'/" \
  "$FORK/src/vs/workbench/browser/workbench.contribution.ts"

# 2b. No Copilot / GitHub sign-in onboarding by default (Claude is the agent here)
sed -i '' "/\[ChatAIDisabledSettingId\]: {/,/default:/ s/default: false/default: true/" \
  "$FORK/src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts"
# Copilot is disabled, so don't fail packaging when its SDK wasn't bundled
sed -i '' 's/throw new Error(`\[prepareBuiltInCopilotRipgrepShim\] Copilot SDK directory not found at ${copilotSdkBase}`);/return;/' \
  "$FORK/build/lib/copilot.ts"

# 2c. Inline review UI (removed-line zones, per-hunk Accept/Reject, floating review bar)
mkdir -p "$FORK/src/vs/workbench/contrib/claudeReview/browser"
cp "$ROOT/fork-patches/claudeReview.contribution.ts" "$FORK/src/vs/workbench/contrib/claudeReview/browser/"
grep -q claudeReview "$FORK/src/vs/workbench/workbench.common.main.ts" || \
  sed -i '' "s#^import './contrib/chat/browser/chat.contribution.js';#&\nimport './contrib/claudeReview/browser/claudeReview.contribution.js';#" "$FORK/src/vs/workbench/workbench.common.main.ts"

# 2d. Claude panel accepts file/folder/image drops like the built-in Chat view
W="$FORK/src/vs/workbench/contrib/webview/browser/webviewElement.ts"
sed -i '' "/if (this.extension?.id.value === 'local.claude-agent') { return; }/d" "$W"   # drop the old pointer-events hack
(cd "$FORK" && git checkout -q -- src/vs/workbench/contrib/webviewView/browser/webviewViewPane.ts)   # superseded by the drop handler in claudeReview.contribution.ts

# 3. Ship the extension built-in (prebuilt bundle, no runtime deps)
DEST=$FORK/extensions/claude-agent
rm -rf "$DEST" && mkdir -p "$DEST"
cp -R "$EXT/out" "$EXT/media" "$EXT/themes" "$DEST/"
node -e "const p=require('$EXT/package.json');for(const k of ['scripts','dependencies','devDependencies'])delete p[k];require('fs').writeFileSync('$DEST/package.json',JSON.stringify(p,null,2))"
echo "Applied to $FORK"
