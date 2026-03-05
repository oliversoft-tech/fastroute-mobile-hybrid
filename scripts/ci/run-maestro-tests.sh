#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:-}"
if [[ -z "$PLATFORM" ]]; then
  echo "Uso: run-maestro-tests.sh <android|ios>" >&2
  exit 1
fi

FLOW_TARGET="${MAESTRO_FLOW_TARGET:-}"
if [[ -z "$FLOW_TARGET" ]]; then
  if [[ -d ".maestro/flows" ]]; then
    FLOW_TARGET=".maestro/flows"
  else
    FLOW_TARGET=".maestro/flow-login-smoke.yaml"
  fi
fi

if [[ ! -e "$FLOW_TARGET" ]]; then
  echo "Fluxo Maestro não encontrado: $FLOW_TARGET" >&2
  exit 1
fi

# Prefer local Homebrew JDK 17 when available (useful for local runs on macOS).
if [[ -d "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" ]]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if ! command -v java >/dev/null 2>&1; then
  echo "Java não encontrado. O Maestro requer Java 17+." >&2
  exit 1
fi

JAVA_VERSION_LINE="$(java -version 2>&1 | head -n1)"
JAVA_MAJOR="$(echo "$JAVA_VERSION_LINE" | sed -E 's/.*version "([0-9]+).*/\1/')"
if [[ -z "${JAVA_MAJOR:-}" || "$JAVA_MAJOR" -lt 17 ]]; then
  echo "Java 17+ é obrigatório para o Maestro. Versão detectada: $JAVA_VERSION_LINE" >&2
  exit 1
fi

# Reuse local Maestro installation when available.
export PATH="$HOME/.maestro/bin:$PATH"
if ! command -v maestro >/dev/null 2>&1; then
  curl -Ls "https://get.maestro.mobile.dev" | bash
  export PATH="$PATH:$HOME/.maestro/bin"
fi

# Reduce flakiness in CI sessions.
export MAESTRO_CLI_NO_ANALYTICS=1

if [[ "$PLATFORM" == "android" ]]; then
  APP_PATH="android/app/build/outputs/apk/debug/app-debug.apk"
  if [[ ! -f "$APP_PATH" ]]; then
    echo "APK debug não encontrado em $APP_PATH" >&2
    exit 1
  fi

  adb install -r "$APP_PATH"
fi

if [[ "$PLATFORM" == "ios" ]]; then
  if ! xcrun simctl list devices booted | grep -q Booted; then
    echo "Nenhum simulador iOS bootado." >&2
    exit 1
  fi

  # Improves stability for driver startup on slower CI runners.
  export MAESTRO_DRIVER_STARTUP_TIMEOUT="${MAESTRO_DRIVER_STARTUP_TIMEOUT:-300000}"
fi

mkdir -p ".maestro/results/$PLATFORM"
RESULT_FILE=".maestro/results/$PLATFORM/junit.xml"
DEBUG_DIR="${MAESTRO_DEBUG_OUTPUT:-.maestro/debug/${PLATFORM}-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$DEBUG_DIR"

echo "Executando Maestro:"
echo "- Platform: $PLATFORM"
echo "- Flow target: $FLOW_TARGET"
echo "- JUnit: $RESULT_FILE"
echo "- Debug output: $DEBUG_DIR"
echo "- Driver startup timeout (ms): ${MAESTRO_DRIVER_STARTUP_TIMEOUT:-default}"

restart_ios_simulator() {
  local sim_id="${MAESTRO_IOS_SIM_ID:-}"
  if [[ -z "$sim_id" ]]; then
    sim_id="$(xcrun simctl list devices booted | awk -F '[()]' '/Booted/ { print $2; exit }')"
  fi

  if [[ -z "$sim_id" ]]; then
    return 0
  fi

  xcrun simctl shutdown "$sim_id" || true
  xcrun simctl boot "$sim_id" || true
  xcrun simctl bootstatus "$sim_id" -b || true
  sleep 8
}

run_one_flow() {
  local flow_path="$1"
  local flow_name="$2"
  local flow_result="$3"
  local flow_debug="$4"

  if maestro test "$flow_path" --format junit --output "$flow_result" --debug-output "$flow_debug"; then
    return 0
  fi

  if [[ "$PLATFORM" != "ios" ]]; then
    return 1
  fi

  echo "Flow '$flow_name' falhou no iOS. Reiniciando simulador e tentando novamente..."
  restart_ios_simulator
  maestro test "$flow_path" --format junit --output "$flow_result" --debug-output "$flow_debug"
}

FLOW_FILES=()
if [[ -d "$FLOW_TARGET" ]]; then
  while IFS= read -r flow; do
    FLOW_FILES+=("$flow")
  done < <(find "$FLOW_TARGET" -maxdepth 1 -type f -name "*.yaml" | sort)
else
  FLOW_FILES+=("$FLOW_TARGET")
fi

if [[ "${#FLOW_FILES[@]}" -eq 0 ]]; then
  echo "Nenhum flow .yaml encontrado em: $FLOW_TARGET" >&2
  exit 1
fi

failures=0
last_result=""

for flow_path in "${FLOW_FILES[@]}"; do
  flow_base="$(basename "$flow_path")"
  flow_name="${flow_base%.yaml}"
  flow_result=".maestro/results/$PLATFORM/junit-${flow_name}.xml"
  flow_debug="$DEBUG_DIR/$flow_name"
  mkdir -p "$flow_debug"

  echo ""
  echo "==> Running flow: $flow_name"
  if run_one_flow "$flow_path" "$flow_name" "$flow_result" "$flow_debug"; then
    echo "Flow '$flow_name' OK"
    last_result="$flow_result"
  else
    echo "Flow '$flow_name' FAILED"
    failures=$((failures + 1))
  fi
done

if [[ -n "$last_result" && -f "$last_result" ]]; then
  cp "$last_result" "$RESULT_FILE"
fi

if [[ "$failures" -gt 0 ]]; then
  echo "Total de flows com falha: $failures" >&2
  exit 1
fi
