#!/bin/sh
# Renders the flyer (docs/flyer/flyer.html) to the plugin page's cover, docs/screenshots/cover.png,
# at 1600 × 1000 in its light theme. Needs Google Chrome or Chromium; set CHROME to its binary
# when it is somewhere else.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../screenshots/cover.png"
chrome=${CHROME:-}
if [ -z "$chrome" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then chrome=$c; break; fi
  done
fi
[ -n "$chrome" ] || { echo "render.sh: no Chrome found; set CHROME" >&2; exit 1; }
"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-color-profile=srgb \
  --blink-settings=preferredColorScheme=1 --force-device-scale-factor=1 --window-size=1600,1000 \
  --virtual-time-budget=3000 --screenshot="$out" "file://$here/flyer.html#cover" 2>/dev/null
echo "$out"
