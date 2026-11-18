#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.x-downloader"
BIN_PATH="$INSTALL_DIR/xvd-translate-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/local.x-downloader.translate.plist"
LOG_PATH="$INSTALL_DIR/bridge.log"
UID_NUM="$(id -u)"

GO_BIN="$(command -v go || true)"
if [ -z "$GO_BIN" ] && [ -x /usr/local/go/bin/go ]; then
  GO_BIN="/usr/local/go/bin/go"
fi
if [ -z "$GO_BIN" ]; then
  echo "Go compiler not found" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$HOME/Library/LaunchAgents"

echo "Building xvd-translate-bridge -> $BIN_PATH"
(cd "$SCRIPT_DIR" && "$GO_BIN" build -trimpath -ldflags="-s -w" -o "$BIN_PATH" .)
chmod +x "$BIN_PATH"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.x-downloader.translate</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_PATH</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>
  <key>StandardErrorPath</key>
  <string>$LOG_PATH</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID_NUM" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_PATH"

echo "Installed and started LaunchAgent: local.x-downloader.translate"
