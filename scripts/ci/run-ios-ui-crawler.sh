#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

BUNDLE_ID="${IOS_BUNDLE_ID:-com.oliverbill.fastroutemobile}"
SIMULATOR_NAME="${IOS_SIMULATOR_NAME:-iPhone 15}"
SIM_BOOT_TIMEOUT_SECONDS="${IOS_BOOT_TIMEOUT_SECONDS:-90}"
IOS_INSTALL_TIMEOUT_SECONDS="${IOS_INSTALL_TIMEOUT_SECONDS:-90}"
CRAWLER_TIMEOUT_SECONDS="${IOS_CRAWLER_TIMEOUT_SECONDS:-120}"
CRAWLER_STATUS_KEY="e2e_ios_crawler_status"
LOG_DIR="${IOS_CRAWLER_LOG_DIR:-$ROOT_DIR/.e2e/ios-crawler}"
STATUS_FILE="$LOG_DIR/status.log"
SYSLOG_FILE="$LOG_DIR/system.log"
IOS_APP_PATH="${IOS_APP_PATH:-}"

mkdir -p "$LOG_DIR"
rm -f "$STATUS_FILE" "$SYSLOG_FILE"

find_available_iphone_id() {
  local preferred_name="$1"
  local preferred_id
  preferred_id="$(xcrun simctl list devices available | awk -F '[()]' -v name="$preferred_name" '$1 ~ name { print $2; exit }')"
  if [[ -n "$preferred_id" ]]; then
    echo "$preferred_id"
    return 0
  fi
  xcrun simctl list devices available | awk -F '[()]' '/iPhone/ { print $2; exit }'
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift

  "$@" &
  local cmd_pid=$!
  local start_ts
  start_ts="$(date +%s)"

  while kill -0 "$cmd_pid" >/dev/null 2>&1; do
    if (( "$(date +%s)" - start_ts >= timeout_seconds )); then
      kill "$cmd_pid" >/dev/null 2>&1 || true
      wait "$cmd_pid" >/dev/null 2>&1 || true
      return 124
    fi
    sleep 1
  done

  wait "$cmd_pid"
}

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 não encontrado no ambiente para leitura do status do crawler." >&2
  exit 1
fi

SIM_ID="${IOS_SIMULATOR_ID:-${IOS_SIMULATOR_UDID:-$(xcrun simctl list devices | awk -F '[()]' '/Booted/ { print $2; exit }')}}"
if [[ -z "$SIM_ID" ]]; then
  SIM_ID="$(find_available_iphone_id "$SIMULATOR_NAME")"
fi

if [[ -z "$SIM_ID" ]]; then
  echo "Nenhum simulador iPhone disponível para o crawler iOS." >&2
  exit 1
fi

cleanup() {
  if [[ -n "${LOG_PID:-}" ]]; then
    kill "$LOG_PID" >/dev/null 2>&1 || true
  fi
  xcrun simctl shutdown "$SIM_ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Booting simulator: $SIM_ID"
xcrun simctl boot "$SIM_ID" >/dev/null 2>&1 || true
if ! run_with_timeout "$SIM_BOOT_TIMEOUT_SECONDS" xcrun simctl bootstatus "$SIM_ID" -b; then
  echo "Timeout aguardando boot do simulador iOS (${SIM_BOOT_TIMEOUT_SECONDS}s)." >&2
  exit 1
fi
open -a Simulator >/dev/null 2>&1 || true

echo "Starting iOS log stream..."
xcrun simctl spawn "$SIM_ID" log stream --style compact --level debug \
  --predicate 'eventMessage CONTAINS "E2E_IOS_CRAWLER"' >"$SYSLOG_FILE" 2>&1 &
LOG_PID=$!

export EXPO_PUBLIC_E2E_BYPASS_LOGIN=1
export EXPO_PUBLIC_E2E_SEED_DATA=1
export EXPO_PUBLIC_E2E_NAV_CRAWLER=1

if [[ -n "$IOS_APP_PATH" ]]; then
  if [[ ! -d "$IOS_APP_PATH" ]]; then
    echo "IOS_APP_PATH não encontrado: $IOS_APP_PATH" >&2
    exit 1
  fi
  echo "Installing prebuilt iOS app from artifact: $IOS_APP_PATH"
  xcrun simctl terminate "$SIM_ID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  if ! run_with_timeout "$IOS_INSTALL_TIMEOUT_SECONDS" xcrun simctl install "$SIM_ID" "$IOS_APP_PATH"; then
    echo "Timeout instalando app iOS no simulador (${IOS_INSTALL_TIMEOUT_SECONDS}s)." >&2
    exit 1
  fi
  if ! run_with_timeout "$IOS_INSTALL_TIMEOUT_SECONDS" xcrun simctl launch "$SIM_ID" "$BUNDLE_ID"; then
    echo "Timeout iniciando app iOS no simulador (${IOS_INSTALL_TIMEOUT_SECONDS}s)." >&2
    exit 1
  fi
else
  echo "Building and installing iOS app with E2E crawler mode enabled..."
  IOS_SIMULATOR_ID="$SIM_ID" IOS_SIMULATOR_NAME="$SIMULATOR_NAME" IOS_CONFIGURATION=Debug \
    bash ./scripts/build-install-ios-local.sh
fi

echo "Waiting crawler status in local database (timeout ${CRAWLER_TIMEOUT_SECONDS}s)..."
deadline=$(( $(date +%s) + CRAWLER_TIMEOUT_SECONDS ))

while [[ "$(date +%s)" -lt "$deadline" ]]; do
  APP_DATA_DIR="$(xcrun simctl get_app_container "$SIM_ID" "$BUNDLE_ID" data 2>/dev/null || true)"
  DB_PATH="$APP_DATA_DIR/Library/LocalDatabase/fastroute_offline.db"

  if [[ -n "$APP_DATA_DIR" && -f "$DB_PATH" ]]; then
    status_value="$(sqlite3 "$DB_PATH" "SELECT value FROM app_settings WHERE key='${CRAWLER_STATUS_KEY}' LIMIT 1;" 2>/dev/null || true)"
    if [[ -n "$status_value" ]]; then
      echo "$status_value" | tee "$STATUS_FILE"
      if [[ "$status_value" == "success" ]]; then
        echo "iOS UI crawler finalizado com sucesso."
        exit 0
      fi
      if [[ "$status_value" == failed:* ]]; then
        echo "iOS UI crawler falhou: $status_value" >&2
        tail -n 80 "$SYSLOG_FILE" || true
        exit 1
      fi
    fi
  fi

  sleep 2
done

echo "Timeout aguardando conclusão do iOS UI crawler." >&2
tail -n 120 "$SYSLOG_FILE" || true
exit 1
