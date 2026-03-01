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

maestro test "$FLOW_TARGET" --format junit --output "$RESULT_FILE" --debug-output "$DEBUG_DIR"
