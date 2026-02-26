#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${IOS_DEVICE_BUILD_ROOT:-/tmp/fastroute-mobile-hybrid-device-build}"
SCHEME="${IOS_SCHEME:-FastRoute}"
CONFIGURATION="${IOS_CONFIGURATION:-Debug}"
BUNDLE_ID="${IOS_BUNDLE_ID:-com.oliverbill.fastroutemobile}"
WORKSPACE_PATH="ios/FastRoute.xcworkspace"

extract_udid_from_line() {
  local line="$1"
  echo "$line" | sed -E 's/.*\(([A-F0-9-]+)\)[[:space:]]*$/\1/'
}

find_connected_iphone_udid() {
  local preferred_name="${IOS_DEVICE_NAME:-iPhone do Bill}"
  local preferred_line
  preferred_line="$(xcrun xctrace list devices | rg -m1 "^${preferred_name} \\(" || true)"
  if [ -n "$preferred_line" ]; then
    extract_udid_from_line "$preferred_line"
    return 0
  fi

  local any_iphone_line
  any_iphone_line="$(xcrun xctrace list devices | rg -m1 '^iPhone.*\([0-9]+\.[0-9]+(\.[0-9]+)?\) \([A-F0-9-]+\)$' || true)"
  if [ -n "$any_iphone_line" ]; then
    extract_udid_from_line "$any_iphone_line"
  fi
}

DEVICE_ID="${IOS_DEVICE_ID:-$(find_connected_iphone_udid)}"
if [ -z "${DEVICE_ID}" ]; then
  echo "Nenhum iPhone físico conectado." >&2
  exit 1
fi

mkdir -p "$BUILD_ROOT"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude ios/Pods \
  --exclude ios/build \
  --exclude android/build \
  "$PROJECT_DIR/" "$BUILD_ROOT/"

pushd "$BUILD_ROOT" >/dev/null
if [ ! -d node_modules ]; then
  npm ci --silent
else
  npm install --silent --no-audit --no-fund
fi

pushd ios >/dev/null
pod install --silent

xcodebuild \
  -workspace "$(basename "$WORKSPACE_PATH")" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "id=$DEVICE_ID" \
  -allowProvisioningUpdates \
  -derivedDataPath "$BUILD_ROOT/.derived-data" \
  build

APP_PATH="$BUILD_ROOT/.derived-data/Build/Products/${CONFIGURATION}-iphoneos/FastRoute.app"
if [ ! -d "$APP_PATH" ]; then
  echo "App não encontrada em $APP_PATH" >&2
  exit 1
fi

xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH"
xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID" --terminate-existing --activate

popd >/dev/null
popd >/dev/null

echo "App iOS instalada com sucesso no dispositivo $DEVICE_ID: $APP_PATH"
