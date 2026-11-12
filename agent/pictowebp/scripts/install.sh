#!/bin/sh
# Install the PicToWebP Rust CLI without admin rights or PATH changes.
#
#   sh install.sh
#   sh install.sh --version 0.3.0 --json
#   sh install.sh --from-file ./pictowebp --sha256 <hash>
set -eu

REPO="${PICTOWEBP_REPO:-aditya-xq/PicToWebP}"
INSTALL_SCHEMA="pictowebp.install/v1"
MANIFEST_SCHEMA="pictowebp.release/v1"

VERSION=""
INSTALL_DIR="${PICTOWEBP_INSTALL_DIR:-$HOME/.local/bin}"
ASSET_URL=""
SHA256=""
FROM_FILE=""
DRY_RUN=0
VERIFY_ONLY=0
UNINSTALL=0
JSON=0
SKIP_ATTESTATION=0
REQUIRE_ATTESTATION=0
VERIFIED=0
ERROR_EMITTED=0

usage() {
    cat <<'EOF'
Usage: install.sh [options]

  --version X.Y.Z      Install a specific release (default: latest)
  --install-dir DIR    Destination directory
  --asset-url URL      Explicit archive URL
  --sha256 HASH        Expected SHA-256 of the archive or --from-file binary
  --from-file PATH     Install a local binary without downloading
  --dry-run            Print the plan; write nothing
  --verify-only        Verify the binary/archive and exit
  --uninstall          Remove the install directory
  --json               Print one JSON object
  --skip-attestation   Do not call `gh attestation verify`
  --require-attestation  Fail unless Sigstore attestation is verified
  -h, --help           Show this help
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --install-dir) INSTALL_DIR="$2"; shift 2 ;;
        --asset-url) ASSET_URL="$2"; shift 2 ;;
        --sha256) SHA256="$2"; shift 2 ;;
        --from-file) FROM_FILE="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --verify-only) VERIFY_ONLY=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --json) JSON=1; shift ;;
        --skip-attestation) SKIP_ATTESTATION=1; shift ;;
        --require-attestation) REQUIRE_ATTESTATION=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# Emit one error object on stdout when --json was requested, then exit 1.
fail() {
    if [ "$JSON" = "1" ] && [ "$ERROR_EMITTED" = "0" ]; then
        printf '{"schema":"%s","error":"%s"}\n' "$INSTALL_SCHEMA" "$(json_escape "$1")"
        ERROR_EMITTED=1
    fi
    echo "error: $1" >&2
    exit 1
}

print_result() {
    # action version path sha on_path dry verified
    verified_bool=false
    [ "$7" = "1" ] && verified_bool=true
    if [ "$JSON" = "1" ]; then
        printf '{"schema":"%s","action":"%s","version":"%s","target":"%s","path":"%s","sha256":"%s","on_path":%s,"verified":%s,"dry_run":%s}\n' \
            "$INSTALL_SCHEMA" "$1" "$(json_escape "$2")" "$TARGET" "$(json_escape "$3")" \
            "$4" "$5" "$verified_bool" "$6"
    else
        echo "PicToWebP ${2:-}"
        echo "  action:  $1"
        echo "  target:  $TARGET"
        echo "  path:    $3"
        echo "  sha256:  $4"
        if [ "$verified_bool" = "true" ]; then
            echo "  verified: yes"
        else
            echo "  verified: no (unverified)"
        fi
        if [ "$5" = "true" ]; then
            echo "  PATH:    on PATH"
        else
            echo "  PATH:    not on PATH (use the absolute path above)"
        fi
    fi
}

detect_target() {
    os=$(uname -s)
    arch=$(uname -m)
    case "$os" in
        Linux)
            case "$arch" in
                x86_64|amd64) echo "x86_64-unknown-linux-musl" ;;
                aarch64|arm64) echo "aarch64-unknown-linux-musl" ;;
                *) return 1 ;;
            esac
            ;;
        Darwin)
            case "$arch" in
                x86_64|amd64) echo "x86_64-apple-darwin" ;;
                arm64|aarch64) echo "aarch64-apple-darwin" ;;
                *) return 1 ;;
            esac
            ;;
        *) return 1 ;;
    esac
}

TARGET=$(detect_target) || fail "Unsupported platform: $(uname -s) $(uname -m)"

if [ "$REQUIRE_ATTESTATION" = "1" ]; then
    [ "$SKIP_ATTESTATION" = "0" ] \
        || fail "--require-attestation conflicts with --skip-attestation"
    command -v gh >/dev/null 2>&1 \
        && gh attestation verify --help >/dev/null 2>&1 \
        || fail "gh with attestation support (2.49+) is required for --require-attestation"
    gh auth token >/dev/null 2>&1 \
        || fail "gh must be authenticated for --require-attestation"
fi

gh_ready() {
    command -v gh >/dev/null 2>&1 \
        && gh attestation verify --help >/dev/null 2>&1 \
        && gh auth token >/dev/null 2>&1
}

if [ "$UNINSTALL" = "1" ]; then
    if [ ! -d "$INSTALL_DIR" ]; then
        print_result "uninstall" "" "$INSTALL_DIR" "" "false" \
            "$([ "$DRY_RUN" = "1" ] && echo true || echo false)" "0"
        exit 0
    fi

    resolved=$(cd "$INSTALL_DIR" && pwd -P)
    home_resolved=$(cd "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")
    case "$resolved" in
        ""|"/"|"$home_resolved") fail "Refusing to remove $INSTALL_DIR" ;;
    esac
    # Only remove a directory this installer created; a path typo must not
    # delete unrelated data.
    [ -f "$resolved/install.json" ] \
        || fail "Refusing to remove $resolved: install.json not found"

    if [ "$DRY_RUN" = "0" ]; then
        rm -rf "$resolved"
    fi
    print_result "uninstall" "" "$resolved" "" "false" \
        "$([ "$DRY_RUN" = "1" ] && echo true || echo false)" "0"
    exit 0
fi

TMP=$(mktemp -d 2>/dev/null) || fail "Could not create a temporary directory"
cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ "$status" -ne 0 ] && [ "$JSON" = "1" ] && [ "$ERROR_EMITTED" = "0" ]; then
        printf '{"schema":"%s","error":"installer failed (exit %s)"}\n' \
            "$INSTALL_SCHEMA" "$status"
    fi
    rm -rf "$TMP"
    exit "$status"
}
trap cleanup EXIT INT TERM

find_python() {
    for candidate in python3 python; do
        if command -v "$candidate" >/dev/null 2>&1 \
            && "$candidate" -c 'import json' >/dev/null 2>&1; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

PYTHON_BIN=$(find_python || true)

fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --proto '=https' --proto-redir '=https' "$1" -o "$2"
    else
        wget -qO "$2" "$1"
    fi
}

manifest_value() {
    "$PYTHON_BIN" - "$1" "$2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
PY
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

BINARY=""
if [ -n "$FROM_FILE" ]; then
    BINARY="$FROM_FILE"
    [ -f "$BINARY" ] || fail "Not a file: $BINARY"
    [ -n "$VERSION" ] || VERSION="local"
    if [ -n "$SHA256" ]; then
        ACTUAL=$(sha256_of "$BINARY")
        [ "$ACTUAL" = "$(printf '%s' "$SHA256" | tr 'A-F' 'a-f')" ] \
            || fail "SHA-256 mismatch for $BINARY"
        VERIFIED=1
    elif [ "$REQUIRE_ATTESTATION" = "0" ]; then
        echo "warning: installing a local binary without --sha256; it is not verified" >&2
    fi
    if [ "$REQUIRE_ATTESTATION" = "1" ]; then
        gh attestation verify "$BINARY" --repo "$REPO" >/dev/null \
            || fail "Binary attestation verification failed"
        VERIFIED=1
    fi
else
    if [ -n "$VERSION" ]; then
        BASE="https://github.com/$REPO/releases/download/rust-v$VERSION"
    else
        BASE="https://github.com/$REPO/releases/download/rust-latest"
    fi

    if [ -z "$ASSET_URL" ]; then
        [ -n "$PYTHON_BIN" ] \
            || fail "python3 or python is required to read latest.json; pass --asset-url and --sha256 instead"
        MANIFEST="$TMP/latest.json"
        fetch "$BASE/latest.json" "$MANIFEST" || fail "Could not download $BASE/latest.json"
        if gh_ready; then
            gh attestation verify "$MANIFEST" --repo "$REPO" >/dev/null \
                || fail "latest.json attestation verification failed"
        elif [ "$SKIP_ATTESTATION" = "0" ]; then
            echo "warning: gh is unavailable, unauthenticated, or too old; skipping manifest attestation" >&2
        fi
        FOUND_SCHEMA=$(manifest_value "$MANIFEST" "schema") \
            || fail "Could not parse latest.json"
        [ "$FOUND_SCHEMA" = "$MANIFEST_SCHEMA" ] \
            || fail "Unexpected manifest schema: $FOUND_SCHEMA"
        [ -n "$VERSION" ] || VERSION=$(manifest_value "$MANIFEST" "version")
        ASSET_URL=$(manifest_value "$MANIFEST" "assets.$TARGET.url") \
            || fail "No release asset for target $TARGET"
        [ -n "$SHA256" ] || SHA256=$(manifest_value "$MANIFEST" "assets.$TARGET.sha256")
    elif [ -z "$VERSION" ]; then
        VERSION="local"
    fi

    ARCHIVE="$TMP/pictowebp.tar.gz"
    fetch "$ASSET_URL" "$ARCHIVE" || fail "Could not download $ASSET_URL"

    ACTUAL=$(sha256_of "$ARCHIVE")
    if [ -n "$SHA256" ]; then
        if [ "$ACTUAL" != "$(printf '%s' "$SHA256" | tr 'A-F' 'a-f')" ]; then
            fail "SHA-256 mismatch: expected $SHA256, got $ACTUAL"
        fi
        VERIFIED=1
    fi
    if [ "$SKIP_ATTESTATION" = "0" ] && gh_ready; then
        gh attestation verify "$ARCHIVE" --repo "$REPO" >/dev/null \
            || fail "Sigstore attestation verification failed"
        VERIFIED=1
    elif [ "$SKIP_ATTESTATION" = "0" ]; then
        echo "warning: gh is unavailable, unauthenticated, or too old; skipping archive attestation" >&2
    fi
    if [ "$VERIFIED" = "0" ]; then
        echo "warning: installing without checksum or attestation verification" >&2
    fi

    mkdir -p "$TMP/expanded"
    tar -xzf "$ARCHIVE" -C "$TMP/expanded" || fail "Could not extract $ARCHIVE"
    BINARY=$(find "$TMP/expanded" -name pictowebp -type f | head -n 1)
    [ -n "$BINARY" ] || fail "Archive did not contain a pictowebp binary"
fi

BINARY_SHA=$(sha256_of "$BINARY") || fail "Could not hash $BINARY"
DEST="$INSTALL_DIR/pictowebp"

on_path() {
    [ -e "$DEST" ] || return 1
    command -v pictowebp >/dev/null 2>&1 || return 1
    [ "$DEST" -ef "$(command -v pictowebp)" ]
}

if [ "$VERIFY_ONLY" = "1" ]; then
    if on_path; then ON_PATH=true; else ON_PATH=false; fi
    if [ -n "$FROM_FILE" ]; then
        VERIFY_PATH="$BINARY"
        VERIFY_SHA="$BINARY_SHA"
        VERIFY_RESULT="$VERIFIED"
    elif [ -f "$DEST" ]; then
        # Hash the installed binary, not the download: the report must describe
        # the file at `path`. It is "verified" only when it matches the
        # checksum/attestation of the release that was just fetched.
        VERIFY_PATH="$DEST"
        VERIFY_SHA=$(sha256_of "$DEST") || fail "Could not hash $DEST"
        VERIFY_RESULT=0
        if [ "$VERIFIED" = "1" ] && [ "$VERIFY_SHA" = "$BINARY_SHA" ]; then
            VERIFY_RESULT=1
        fi
    else
        VERIFY_PATH="$DEST"
        VERIFY_SHA=""
        VERIFY_RESULT=0
    fi
    print_result "verify" "$VERSION" "$VERIFY_PATH" "$VERIFY_SHA" "$ON_PATH" "true" "$VERIFY_RESULT"
    exit 0
fi

if [ "$DRY_RUN" = "0" ]; then
    mkdir -p "$INSTALL_DIR"
    STAGED="$INSTALL_DIR/.pictowebp.new"
    cp "$BINARY" "$STAGED"
    chmod 755 "$STAGED"
    mv -f "$STAGED" "$DEST"
    if [ "$VERIFIED" = "1" ]; then VERIFIED_JSON=true; else VERIFIED_JSON=false; fi
    printf '{\n  "schema": "pictowebp.install/v1",\n  "version": "%s",\n  "target": "%s",\n  "sha256": "%s",\n  "verified": %s,\n  "path": "%s",\n  "installed": "%s"\n}\n' \
        "$VERSION" "$TARGET" "$BINARY_SHA" "$VERIFIED_JSON" "$(json_escape "$DEST")" "$(date +%Y-%m-%d)" > "$INSTALL_DIR/install.json"
fi

# Recomputed after the move so a fresh install into a PATH directory is
# reported accurately.
if on_path; then ON_PATH=true; else ON_PATH=false; fi

if [ "$DRY_RUN" = "1" ]; then ACTION="plan"; else ACTION="install"; fi
print_result "$ACTION" "$VERSION" "$DEST" "$BINARY_SHA" "$ON_PATH" \
    "$([ "$DRY_RUN" = "1" ] && echo true || echo false)" "$VERIFIED"
