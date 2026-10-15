#!/bin/sh
# Vendor Babylon's KTX2 decoder into public/ktx2 (served same-origin; Babylon's default is cdn.babylonjs.com).
# The decoder's version follows @babylonjs/core: run this again after bumping it.
#   apps/client/scripts/vendorKtx2.sh
set -eu
cd "$(dirname "$0")/.."
V=$(node -p "require('@babylonjs/core/package.json').version")
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
(cd "$T" && npm pack --silent "babylonjs-ktx2decoder@$V" >/dev/null && mkdir umd && tar xzf "babylonjs-ktx2decoder-$V.tgz" -C umd)
(cd "$T" && npm pack --silent "@babylonjs/ktx2decoder@$V" >/dev/null && mkdir es && tar xzf "babylonjs-ktx2decoder-$V.tgz" -C es)
rm -rf public/ktx2
mkdir -p public/ktx2
cp "$T/umd/package/babylon.ktx2Decoder.js" public/ktx2/
for f in msc_basis_transcoder.js msc_basis_transcoder.wasm uastc_astc.wasm uastc_bc7.wasm uastc_r8_unorm.wasm uastc_rg8_unorm.wasm \
         uastc_rgba8_srgb_v2.wasm uastc_rgba8_unorm_v2.wasm zstddec.wasm license.md; do
	cp "$T/es/package/wasm/$f" public/ktx2/
done
cp "$T/umd/package/license.md" public/ktx2/license-ktx2Decoder.md
printf '%s\n' "$V" > public/ktx2/VERSION
echo "public/ktx2: Babylon KTX2 decoder $V"
