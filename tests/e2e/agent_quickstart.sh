#!/bin/sh
# Doc-drift guard: run every command the skill's quickstart tells an agent to
# use, against a disposable copy of the shared fixture corpus.
#
#   sh tests/e2e/agent_quickstart.sh ./src_rust/target/release/pictowebp
#
# Exits non-zero on the first mismatch. Requires python3 or python for JSON
# validation.
set -eu

PYTHON_BIN=${PYTHON:-}
if [ -z "$PYTHON_BIN" ]; then
    for candidate in python3 python; do
        if command -v "$candidate" >/dev/null 2>&1 \
            && "$candidate" -c 'import json' >/dev/null 2>&1; then
            PYTHON_BIN="$candidate"
            break
        fi
    done
fi
if [ -z "$PYTHON_BIN" ]; then
    echo "python3 or python is required for JSON validation" >&2
    exit 2
fi

BIN="${1:-${PICTOWEBP_BIN:-}}"
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
    echo "usage: $0 <path-to-pictowebp>" >&2
    exit 2
fi

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
FIXTURES="$ROOT/tests/e2e/fixtures"
WORK=$(mktemp -d 2>/dev/null || mktemp -d -t pictowebp-agent)
trap 'rm -rf "$WORK"' EXIT INT TERM

cp -R "$FIXTURES/." "$WORK/source"

json_check() {
    "$PYTHON_BIN" - "$1" "$2" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["schema"] == sys.argv[2], data.get("schema")
PY
}

echo "1. info"
"$BIN" --info --json > "$WORK/info.json"
json_check "$WORK/info.json" "pictowebp.info/v1"

echo "2. version"
"$BIN" --version | grep -q "pictowebp"

echo "3. folder conversion"
"$BIN" "$WORK/source" --json --no-progress > "$WORK/result.json" 2>/dev/null
json_check "$WORK/result.json" "pictowebp.result/v1"
"$PYTHON_BIN" - "$WORK/result.json" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["counts"]["converted"] >= 1, data["counts"]
assert data["output"], data
PY

echo "4. dry run writes nothing"
before=$(find "$WORK" -maxdepth 1 -name "source_webp_*" | wc -l)
"$BIN" "$WORK/source" --json --dry-run > "$WORK/plan.json" 2>/dev/null
json_check "$WORK/plan.json" "pictowebp.result/v1"
after=$(find "$WORK" -maxdepth 1 -name "source_webp_*" | wc -l)
[ "$before" = "$after" ] || { echo "dry run created an output folder" >&2; exit 1; }

echo "5. single image"
"$BIN" "$WORK/source/a.png" --json > "$WORK/single.json" 2>/dev/null
json_check "$WORK/single.json" "pictowebp.result/v1"
[ -f "$WORK/source/a.webp" ] || { echo "single-file output missing" >&2; exit 1; }

echo "6. explicit --out"
mkdir -p "$WORK/dest"
"$BIN" "$WORK/source/b.jpg" --json --out "$WORK/dest" > "$WORK/out.json" 2>/dev/null
[ -f "$WORK/dest/b.webp" ] || { echo "--out output missing" >&2; exit 1; }

echo "agent quickstart: ok"
