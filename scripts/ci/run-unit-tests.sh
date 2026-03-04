#!/usr/bin/env bash
set -euo pipefail

# Avoid relying on shell globstar behavior in CI (Node 20 + bash).
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TEST_FILES=()
while IFS= read -r file; do
  TEST_FILES+=("$file")
done < <(find test/unit -type f -name '*.test.ts' | sort)

if [ "${#TEST_FILES[@]}" -eq 0 ]; then
  echo "Nenhum teste unitario encontrado em test/unit" >&2
  exit 1
fi

node --import tsx --test "${TEST_FILES[@]}"
