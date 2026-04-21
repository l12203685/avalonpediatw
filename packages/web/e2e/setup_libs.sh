#!/usr/bin/env bash
# One-time setup for WSL2 environments that lack Chromium system dependencies.
# Downloads libnspr4, libnss3, libasound2 from Ubuntu archive and places them
# in /tmp/chrome_libs for use via LD_LIBRARY_PATH.
#
# Does NOT require sudo. Idempotent — safe to run multiple times.
#
# Usage:
#   bash packages/web/e2e/setup_libs.sh
#
# After running, execute tests with:
#   LD_LIBRARY_PATH=/tmp/chrome_libs \
#   /home/zero/.npm/_npx/e41f203b7505f1fb/node_modules/.bin/playwright test \
#   --config=packages/web/playwright.config.ts

set -e

UBUNTU_ARCHIVE="http://archive.ubuntu.com/ubuntu/pool"
LIBS_DIR="/tmp/chrome_libs"
TMP_DEB_DIR="/tmp/playwright_debs"

mkdir -p "$LIBS_DIR" "$TMP_DEB_DIR"

download_and_extract() {
  local url="$1"
  local deb_file="$TMP_DEB_DIR/$(basename "$url")"
  local extract_dir="$TMP_DEB_DIR/$(basename "$url" .deb)_extracted"

  if [ -f "$deb_file" ] && [ "$(stat -c%s "$deb_file")" -gt 10000 ]; then
    echo "  Already downloaded: $(basename "$url")"
  else
    echo "  Downloading: $(basename "$url")"
    curl -fsSL --connect-timeout 15 "$url" -o "$deb_file"
  fi

  mkdir -p "$extract_dir"
  dpkg-deb -x "$deb_file" "$extract_dir" 2>/dev/null || {
    echo "  ERROR: Failed to extract $deb_file"
    return 1
  }

  # Copy .so files to libs dir
  find "$extract_dir" -name "*.so*" -type f | while read -r so; do
    cp "$so" "$LIBS_DIR/"
    echo "  Copied: $(basename "$so")"
  done
}

echo "[setup_libs] Installing Chromium shared library dependencies..."

download_and_extract "$UBUNTU_ARCHIVE/main/n/nspr/libnspr4_4.35-1.1build1_amd64.deb"
download_and_extract "$UBUNTU_ARCHIVE/main/n/nss/libnss3_3.98-1ubuntu0.1_amd64.deb"
download_and_extract "$UBUNTU_ARCHIVE/main/a/alsa-lib/libasound2t64_1.2.11-1ubuntu0.2_amd64.deb"

echo ""
echo "[setup_libs] Libraries in $LIBS_DIR:"
ls "$LIBS_DIR/"
echo ""
echo "[setup_libs] Done. Run tests with:"
echo "  LD_LIBRARY_PATH=$LIBS_DIR \\"
echo "  /home/zero/.npm/_npx/e41f203b7505f1fb/node_modules/.bin/playwright test \\"
echo "  --config=packages/web/playwright.config.ts"
