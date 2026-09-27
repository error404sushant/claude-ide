#!/bin/sh
# macOS shortcut for: node scripts/build.mjs --package   (see scripts/build.mjs; on Windows run that command directly)
[ "$(node -v 2>/dev/null | cut -d. -f1)" = "v24" ] || { [ -x /opt/homebrew/opt/node@24/bin/node ] && export PATH="/opt/homebrew/opt/node@24/bin:$PATH"; }
exec node "$(cd "$(dirname "$0")" && pwd)/scripts/build.mjs" --package "$@"
