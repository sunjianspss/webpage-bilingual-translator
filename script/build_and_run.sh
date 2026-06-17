#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT_DIR/safari/网页双语翻译/网页双语翻译.xcodeproj"
SCHEME="网页双语翻译"
APP_NAME="网页双语翻译"
BUILD_DIR="$ROOT_DIR/outputs/safari-build"
APP_BUNDLE="$BUILD_DIR/Build/Products/Debug/$APP_NAME.app"
INSTALL_BUNDLE="/Applications/$APP_NAME.app"
BUNDLE_ID="com.sun.webpagetranslator"

pkill -x "$APP_NAME" >/dev/null 2>&1 || true

xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -derivedDataPath "$BUILD_DIR" \
  -destination "platform=macOS" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM= \
  build

install_app() {
  /usr/bin/ditto "$APP_BUNDLE" "$INSTALL_BUNDLE"
  /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister \
    -f -R -trusted "$INSTALL_BUNDLE"
}

open_app() {
  install_app
  /usr/bin/open -n "$INSTALL_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    install_app
    lldb -- "$INSTALL_BUNDLE/Contents/MacOS/$APP_NAME"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    sleep 2
    pgrep -x "$APP_NAME" >/dev/null
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
