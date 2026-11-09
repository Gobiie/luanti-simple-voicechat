#!/usr/bin/env bash
# Build the native Simple Voice Chat Luanti client from a clean pinned checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$ROOT/client/luanti}"
BUILD="${2:-$ROOT/client/build}"
COMMIT="18cbd54dbbc0449b8329dd6fe32bdb387e63bb79"
PATCH="$ROOT/client/patches/0001-native-voicechat.patch"

if [[ ! -f "$PATCH" ]]; then
	echo "Missing $PATCH" >&2
	exit 1
fi

if [[ ! -d "$SRC/.git" ]]; then
	git clone --recurse-submodules https://github.com/luanti-org/luanti.git "$SRC"
fi

git -C "$SRC" fetch --all --tags
git -C "$SRC" checkout "$COMMIT"
git -C "$SRC" submodule update --init --recursive
git -C "$SRC" apply --check "$PATCH"
git -C "$SRC" apply "$PATCH"

cmake -S "$SRC" -B "$BUILD" \
	-DBUILD_CLIENT=TRUE \
	-DBUILD_SERVER=FALSE \
	-DENABLE_SOUND=TRUE \
	-DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" -j"$(nproc)"

echo
echo "Built client: $SRC/bin/luanti (or $BUILD/bin/luanti)"
echo "Set voicechat.relay_host / voicechat.relay_port in minetest.conf, then /voice in game."
