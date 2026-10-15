#!/bin/sh
# Encode the built-in surface textures (public/assets/tex/*.jpg) to KTX2 beside them: Basis ETC1S, mipmapped, quality
# 128, flipped vertically (-y_flip) so they land the same way up as Babylon's flipped JPEGs (it does not flip compressed
# data). Needs basisu (Basis Universal 2.x, github.com/BinomialLLC/basis_universal): BASISU=/path/to/basisu.
#   apps/client/scripts/encodeKtx2.sh [name …]     (default: every .jpg)
set -eu
cd "$(dirname "$0")/../public/assets/tex"
B="${BASISU:-basisu}"
command -v "$B" >/dev/null 2>&1 || { echo "basisu not found: set BASISU" >&2; exit 1; }
if [ $# -eq 0 ]; then set -- *.jpg; fi
for f in "$@"; do
	n="${f%.jpg}"
	"$B" -ktx2 -mipmap -q 128 -y_flip -file "$n.jpg" -output_file "$n.ktx2" >/dev/null
	printf '%-28s jpg %8s  ktx2 %8s\n' "$n" "$(wc -c < "$n.jpg")" "$(wc -c < "$n.ktx2")"
done
