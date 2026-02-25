#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${IOS_LOCAL_BUILD_ROOT:-/tmp/fastroute-mobile-hybrid-build}"
SCHEME="${IOS_SCHEME:-FastRoute}"
CONFIGURATION="${IOS_CONFIGURATION:-Release}"
BUNDLE_ID="${IOS_BUNDLE_ID:-com.oliverbill.fastroutemobile}"
WORKSPACE_PATH="ios/FastRoute.xcworkspace"

booted_simulator_id() {
  xcrun simctl list devices | awk -F '[()]' '/Booted/ { print $2; exit }'
}

find_available_iphone_id() {
  local preferred_name="${IOS_SIMULATOR_NAME:-iPhone 16 Pro}"
  local preferred_id
  preferred_id="$(xcrun simctl list devices available | awk -F '[()]' -v name="$preferred_name" '$1 ~ name { print $2; exit }')"
  if [ -n "$preferred_id" ]; then
    echo "$preferred_id"
    return 0
  fi
  xcrun simctl list devices available | awk -F '[()]' '/iPhone/ { print $2; exit }'
}

SIM_ID="${IOS_SIMULATOR_ID:-$(booted_simulator_id)}"
if [ -z "$SIM_ID" ]; then
  SIM_ID="$(find_available_iphone_id)"
  if [ -z "$SIM_ID" ]; then
    echo "Nenhum simulador iPhone disponível." >&2
    exit 1
  fi
  xcrun simctl boot "$SIM_ID" || true
fi

open -a Simulator >/dev/null 2>&1 || true

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
  -sdk iphonesimulator \
  -destination "id=$SIM_ID" \
  -derivedDataPath "$BUILD_ROOT/.derived-data" \
  build

APP_PATH="$BUILD_ROOT/.derived-data/Build/Products/${CONFIGURATION}-iphonesimulator/FastRoute.app"
if [ ! -d "$APP_PATH" ]; then
  echo "App não encontrado em $APP_PATH" >&2
  exit 1
fi

xcrun simctl install "$SIM_ID" "$APP_PATH"
xcrun simctl launch "$SIM_ID" "$BUNDLE_ID"
popd >/dev/null
popd >/dev/null

echo "App iOS local instalado com sucesso no simulador $SIM_ID: $APP_PATH"
