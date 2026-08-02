#!/usr/bin/env bash
# Regenerate the iOS and Android launcher icons from apps/flutter/assets/icon/qrai-icon.svg.
#
#   bash scripts/generate-app-icons.sh
#
# The SVG is the source of truth and reproduces .brand-mark from apps/web/src/styles.css — the same
# green, the same gold, the same 16-point star, the same ق. Replace the SVG and re-run; do not hand-
# edit the PNGs.
#
# Needs rsvg-convert and ImageMagick (`brew install librsvg imagemagick`) and an Arabic-capable font
# (Noto Sans Arabic). The glyph is rendered at generation time, so neither is needed to BUILD the
# app — only to change the icon.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
svg="$root/apps/flutter/assets/icon/qrai-icon.svg"
ios="$root/apps/flutter/ios/Runner/Assets.xcassets/AppIcon.appiconset"
android="$root/apps/flutter/android/app/src/main/res"

for tool in rsvg-convert magick; do
  command -v "$tool" >/dev/null || { echo "missing $tool — brew install librsvg imagemagick"; exit 1; }
done

render() { # size, out
  rsvg-convert -w "$1" -h "$1" -o "$2" "$svg"
  # Apple REJECTS an app icon with an alpha channel. The SVG is full-bleed so nothing is actually
  # transparent, but rsvg still writes RGBA — flatten it and drop the channel.
  magick "$2" -background none -alpha remove -alpha off "$2"
}

echo "iOS…"
while read -r size name; do
  render "$size" "$ios/$name"
  echo "  $name (${size}px)"
done <<'ICONS'
20 Icon-App-20x20@1x.png
40 Icon-App-20x20@2x.png
60 Icon-App-20x20@3x.png
29 Icon-App-29x29@1x.png
58 Icon-App-29x29@2x.png
87 Icon-App-29x29@3x.png
40 Icon-App-40x40@1x.png
80 Icon-App-40x40@2x.png
120 Icon-App-40x40@3x.png
120 Icon-App-60x60@2x.png
180 Icon-App-60x60@3x.png
76 Icon-App-76x76@1x.png
152 Icon-App-76x76@2x.png
167 Icon-App-83.5x83.5@2x.png
1024 Icon-App-1024x1024@1x.png
ICONS

echo "Android…"
while read -r size dir; do
  render "$size" "$android/$dir/ic_launcher.png"
  echo "  $dir (${size}px)"
done <<'ICONS'
48 mipmap-mdpi
72 mipmap-hdpi
96 mipmap-xhdpi
144 mipmap-xxhdpi
192 mipmap-xxxhdpi
ICONS

echo "done."
