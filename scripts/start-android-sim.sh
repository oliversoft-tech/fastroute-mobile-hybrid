#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
AVD_NAME="${ANDROID_AVD_NAME:-FastRoute_API_34}"
PORT="${EXPO_PORT:-8081}"

export ANDROID_HOME
export ANDROID_SDK_ROOT="$SDK_ROOT"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb não encontrado. Instale android-platform-tools e configure ANDROID_HOME." >&2
  exit 1
fi

if ! command -v emulator >/dev/null 2>&1; then
  echo "emulator não encontrado. Instale android-commandlinetools e o pacote emulator." >&2
  exit 1
fi

if ! avdmanager list avd | rg -q "Name: ${AVD_NAME}"; then
  echo "AVD '${AVD_NAME}' não encontrado. Crie-o antes de rodar este script." >&2
  exit 1
fi

if ! adb devices | rg -q "emulator-.*device"; then
  nohup emulator \
    -avd "$AVD_NAME" \
    -no-snapshot-load \
    -no-snapshot-save \
    -gpu swiftshader_indirect \
    -no-audio \
    -no-boot-anim \
    -netdelay none \
    -netspeed full >/tmp/android-emulator.log 2>&1 &
fi

for _ in {1..120}; do
  if adb devices | rg -q "emulator-.*device"; then
    BOOTED="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
    if [[ "$BOOTED" == "1" ]]; then
      break
    fi
  fi
  sleep 2
done

if ! adb devices | rg -q "emulator-.*device"; then
  echo "Emulador não ficou disponível." >&2
  exit 1
fi

if ! lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  nohup env CI=1 npx expo start --port "$PORT" >/tmp/expo-android.log 2>&1 &
  sleep 6
fi

adb reverse "tcp:${PORT}" "tcp:${PORT}" >/dev/null 2>&1 || true
adb shell monkey -p host.exp.exponent -c android.intent.category.LAUNCHER --pct-syskeys 0 1 >/dev/null 2>&1 || true
adb shell am start -a android.intent.action.VIEW -d "exp://127.0.0.1:${PORT}" host.exp.exponent >/dev/null 2>&1 || true

echo "Android emulator pronto com Expo em exp://127.0.0.1:${PORT}"
