#!/bin/sh
# Regression guard for `install.sh --uninstall`: a trailing slash or a path
# typo must never delete the home directory or unrelated data.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
INSTALLER="$ROOT/agent/pictowebp/scripts/install.sh"
WORK=$(mktemp -d 2>/dev/null) || exit 2
trap 'rm -rf "$WORK"' EXIT INT TERM

fail() {
    echo "install guard: $1" >&2
    exit 1
}

# 1. A trailing slash on HOME must not bypass the guard.
mkdir -p "$WORK/home/sub"
if HOME="$WORK/home" sh "$INSTALLER" --uninstall --install-dir "$WORK/home/" \
    --json >/dev/null 2>&1; then
    fail "expected refusal for HOME with a trailing slash"
fi
[ -d "$WORK/home" ] || fail "home directory was removed"

# 2. An unrelated directory must not be removed.
mkdir -p "$WORK/unrelated"
echo keep > "$WORK/unrelated/keep.txt"
if sh "$INSTALLER" --uninstall --install-dir "$WORK/unrelated" --json >/dev/null 2>&1; then
    fail "expected refusal for a non-install directory"
fi
[ -f "$WORK/unrelated/keep.txt" ] || fail "unrelated data was removed"

# 3. A directory created by the installer is removed.
mkdir -p "$WORK/install"
: > "$WORK/install/install.json"
if ! sh "$INSTALLER" --uninstall --install-dir "$WORK/install" --json >/dev/null; then
    fail "expected a real install directory to be removed"
fi
[ ! -d "$WORK/install" ] || fail "install directory was not removed"

# 4. A local install records the binary path used by the skill's detection order.
printf '#!/bin/sh\nexit 0\n' > "$WORK/fake-binary"
if ! sh "$INSTALLER" --from-file "$WORK/fake-binary" --install-dir "$WORK/tools" \
    --json >/dev/null 2>&1; then
    fail "local install failed"
fi
[ -x "$WORK/tools/pictowebp" ] || fail "installed binary missing"
grep -q '"path"' "$WORK/tools/install.json" || fail "install.json is missing the path field"
grep -q "$WORK/tools/pictowebp" "$WORK/tools/install.json" \
    || fail "install.json path does not point at the binary"

# 5. --verify-only on a local file hashes that file, not a downloaded artifact.
if ! sh "$INSTALLER" --from-file "$WORK/fake-binary" --verify-only --json \
    > "$WORK/verify.json" 2>/dev/null; then
    fail "verify-only failed for a local file"
fi
grep -q "$WORK/fake-binary" "$WORK/verify.json" \
    || fail "verify-only reported the wrong path"

echo "install guard: ok"
