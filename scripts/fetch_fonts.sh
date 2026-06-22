#!/usr/bin/env bash
#
# Regenerate the self-hosted web fonts used by the LNemail UI.
#
# These assets replace the Google Fonts CDN so the production site makes
# no third-party requests. Run this only when you need to refresh the
# fonts or add a newly used Material Symbols icon.
#
#   ./scripts/fetch_fonts.sh
#
# Outputs (committed to the repo):
#   src/lnemail/static/fonts/JetBrainsMono-Regular.woff2
#   src/lnemail/static/fonts/MaterialSymbolsOutlined.woff2   (subset)
#
# The Material Symbols font is subset to ONLY the icon names listed in
# ICON_NAMES below; the full variable font is ~4 MB, the subset ~34 KB.
# If you add a new `material-symbols-outlined` glyph in the templates or
# JS, add its name here and re-run this script.
set -euo pipefail

cd "$(dirname "$0")/.."
FONT_DIR="src/lnemail/static/fonts"

# A desktop Chrome UA makes Google Fonts serve modern woff2 files.
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# Keep this list in sync with the icons referenced in templates/ and
# static/js/. Discover them with:
#   rg -o "material-symbols-outlined[^>]*>([a-z_]+)<" -r '$1' src/lnemail
ICON_NAMES="api,arrow_back,audio_file,bolt,check,check_circle,circle,close,code,content_copy,description,error,folder_zip,grid_on,history,image,inbox,info,insert_drive_file,mail,mark_email_unread,monitoring,picture_as_pdf,progress_activity,receipt_long,refresh,reply,schedule,send,slideshow,table_chart,verified_user,video_file,visibility,visibility_off,warning,wifi_off"

fetch_first_src() {
    # Print the first `src: url(...)` woff2 URL from a Google Fonts CSS payload.
    local css_url="$1"
    curl -sSL -A "$UA" "$css_url" \
        | grep -oE "https://fonts.gstatic.com/[^)]+" \
        | head -1
}

echo "==> JetBrains Mono (latin, weights 400..700)"
JB_CSS="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap"
# The latin face is the last @font-face block; grab the final URL.
JB_URL="$(curl -sSL -A "$UA" "$JB_CSS" | grep -oE "https://fonts.gstatic.com/[^)]+" | tail -1)"
curl -sSL -A "$UA" "$JB_URL" -o "$FONT_DIR/JetBrainsMono-Regular.woff2"
echo "    saved $FONT_DIR/JetBrainsMono-Regular.woff2"

echo "==> Material Symbols Outlined (subset of ${ICON_NAMES})"
MS_CSS="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&icon_names=${ICON_NAMES}&display=swap"
MS_URL="$(fetch_first_src "$MS_CSS")"
curl -sSL -A "$UA" "$MS_URL" -o "$FONT_DIR/MaterialSymbolsOutlined.woff2"
echo "    saved $FONT_DIR/MaterialSymbolsOutlined.woff2"

echo "Done. Font CSS lives in $FONT_DIR/webfonts.css and inter.css."
