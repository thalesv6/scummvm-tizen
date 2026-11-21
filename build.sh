#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs inside the container: /src is a docker volume (ScummVM source, emsdk, game zips),
# /work is this project folder (tizen/ files in, the .wgt out).
# BUNDLE_FREEWARE_GAMES=false builds ScummVM-no-games.wgt instead of ScummVM.wgt.
set -euo pipefail

BUNDLE_FREEWARE_GAMES=${BUNDLE_FREEWARE_GAMES:-true}
SCUMMVM_COMMIT=d187209bb0560cbdc8d6adea60cfa3c754a35544
SCUMMVM_ICONS_COMMIT=1ef876f6ea88a20bccc70be6d12ae0ee0d8594e7
ENGINES=scumm,scumm_7_8,he,sky,queen,lure,drascula,agi,sci,agos,kyra,sword1,sword2,tinsel,saga,gob,cine
CONFIGURE_ARGS="--disable-all-engines --enable-engine=$ENGINES --enable-release --enable-vkeybd --enable-mad --enable-png --enable-zlib --enable-freetype2 --enable-fribidi --datadir=/data"

SRC=/src/scummvm
WIDGET=/src/widget

if [ ! -d "$SRC/.git" ]; then
	git clone --filter=blob:none https://github.com/scummvm/scummvm.git "$SRC"
fi
cd "$SRC"
git fetch -q origin "$SCUMMVM_COMMIT" 2>/dev/null || true
git checkout -q "$SCUMMVM_COMMIT"
# Skip patches that are already applied, so make does not recompile them on every build.
for patch in /work/patches/*.patch; do
	git apply --check -R "$patch" 2>/dev/null || git apply "$patch"
done

# configure rewrites config.h and forces a full rebuild, so only rerun it when the flags change.
TASKS="make dist"
if [ "$(cat .tizen-configure 2>/dev/null)" != "$CONFIGURE_ARGS" ]; then
	TASKS="configure make dist"
fi
./dists/emscripten/build.sh $TASKS $CONFIGURE_ARGS
echo "$CONFIGURE_ARGS" > .tizen-configure

rm -rf "$WIDGET"
cp -r "$SRC/build-emscripten" "$WIDGET"

# fetch_game <dir> <sha256> <url>: unpacks a freeware zip into data/games/<dir>, flattening a single top-level folder.
# Several zips may go into the same <dir> (game data + audio pack).
fetch_game() {
	local zip="/src/games/$(basename "$3")" dest="$WIDGET/data/games/$1"
	mkdir -p /src/games "$dest"
	[ -f "$zip" ] || wget -nv -O "$zip" "$3"
	echo "$2  $zip" | sha256sum -c --quiet -
	unzip -q -o "$zip" -d "$dest"
	local entries=("$dest"/*)
	if [ ${#entries[@]} -eq 1 ] && [ -d "${entries[0]}" ]; then
		mv "${entries[0]}"/* "$dest"/ && rmdir "${entries[0]}"
	fi
}
if [ "$BUNDLE_FREEWARE_GAMES" = true ]; then
	WGT_NAME=ScummVM.wgt
	fetch_game sky      53209b9400eab6fd7fa71518b2f357c8de75cfeaa5ba57024575ab79cc974593 "https://downloads.scummvm.org/frs/extras/Beneath%20a%20Steel%20Sky/bass-cd-1.2.zip"
	fetch_game queen    2e59de85f708cdb32bf85c85b394ac091c05f7647e856b71f5b3ae73fde761e0 "https://downloads.scummvm.org/frs/extras/Flight%20of%20the%20Amazon%20Queen/FOTAQ_Floppy.zip"
	fetch_game lure     f3178245a1483da1168c3a11e70b65d33c389f1f5df63d4f3a356886c1890108 "https://downloads.scummvm.org/frs/extras/Lure%20of%20the%20Temptress/lure-1.1.zip"
	fetch_game drascula b731f6cb5a22ba8b4c3b3362f570b9a10a67b6cb0b395394b19a94b36e4e42de "https://downloads.scummvm.org/frs/extras/Drascula_%20The%20Vampire%20Strikes%20Back/drascula-1.0.zip"
	# Both Drascula zips ship a readme.txt, and the game's license requires keeping each one intact.
	mv "$WIDGET/data/games/drascula/readme.txt" "$WIDGET/data/games/drascula/readme-game.txt"
	fetch_game drascula 32bdb6d5163e538ffe20f6320e20e0b24050823be516775364be629ab1b52eee "https://downloads.scummvm.org/frs/extras/Drascula_%20The%20Vampire%20Strikes%20Back/drascula-audio-mp3-2.0.zip"

	# The same games unpacked, for GitHub Pages, in the layout tools/pc-server.py serves (list.json + files/),
	# so the TV downloads them with its "Copy from PC" code. Copied before the http-fs index files are added.
	MIRROR=/work/freeware-mirror
	rm -rf "$MIRROR"
	mkdir -p "$MIRROR/files"
	cp -r "$WIDGET/data/games/." "$MIRROR/files/"
	rm -f "$MIRROR/files/index.json"
	(cd "$MIRROR/files" && find . -type f -printf '%P\t%s\n') | python3 -c '
import json, sys
print(json.dumps({path: int(size) for path, size in (line.rstrip("\n").split("\t") for line in sys.stdin)}))
' > "$MIRROR/list.json"
else
	WGT_NAME=ScummVM-no-games.wgt
fi
if [ -d /work/games ]; then
	cp -r /work/games/. "$WIDGET/data/games/"
fi

# Covers for the grid launcher. The freeware ones come in the package; games.js downloads the rest from
# scummvm-icons on demand. http-fs only reads files its index.json names, with their exact size, so the index
# lists every cover of our engines at the pinned commit.
COVERS="$WIDGET/data/gui-icons/icons"
COVERS_TREE="/src/scummvm-icons-$SCUMMVM_ICONS_COMMIT.json"
mkdir -p "$COVERS"
if [ "$BUNDLE_FREEWARE_GAMES" = true ]; then
	unzip -q -o -j "$SRC/gui/themes/gui-icons.dat" icons/sky-sky.png icons/queen-queen.png icons/lure-lure.png \
		icons/drascula-drascula.png -d "$COVERS"
fi
[ -f "$COVERS_TREE" ] || wget -nv -O "$COVERS_TREE" \
	"https://api.github.com/repos/scummvm/scummvm-icons/git/trees/$SCUMMVM_ICONS_COMMIT?recursive=1"

python3 "$SRC/dists/emscripten/build-make_http_index.py" "$WIDGET/data"

python3 - "$COVERS_TREE" "$COVERS" "$ENGINES" <<'EOF'
import json, os, re, sys
tree_file, covers, engines = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
cover_name = re.compile(r"^icons/((" + "|".join(engines) + r")[-.][^/]*\.png)$")
index = {}
for entry in json.load(open(tree_file))["tree"]:
    match = cover_name.match(entry["path"])
    if match:
        index[match.group(1)] = entry["size"]
# The bundled copies come from gui-icons.dat, which may not match the pinned commit byte for byte.
for name in os.listdir(covers):
    if name.endswith(".png"):
        index[name] = os.path.getsize(os.path.join(covers, name))
json.dump(index, open(os.path.join(covers, "index.json"), "w"))
print(len(index), "covers listed")
EOF

cp /work/tizen/config.xml /work/tizen/tv.js /work/tizen/games.js /work/tizen/qrcode.js /work/tizen/scummvm.ini "$WIDGET/"
sed -i "s|@SCUMMVM_ICONS_COMMIT@|$SCUMMVM_ICONS_COMMIT|" "$WIDGET/games.js"
if [ "$BUNDLE_FREEWARE_GAMES" = true ]; then
	cat /work/tizen/freeware-games.ini >> "$WIDGET/scummvm.ini"
fi
cp "$SRC/dists/emscripten/assets/scummvm-512.png" "$WIDGET/icon.png"
# the generated HTML is minified, so the src attribute may come without quotes;
# games.js wraps the fetch that tv.js fixes, so it loads after it
sed -i 's|<script[^>]*src="\?scummvm.js|<script src="qrcode.js"></script><script src="tv.js"></script><script src="games.js"></script>&|' "$WIDGET/scummvm.html"
mv "$WIDGET/scummvm.html" "$WIDGET/index.html"
grep -q 'src="games.js"' "$WIDGET/index.html" || { echo "script injection failed"; exit 1; }

cd /src
expect <<'EOF'
set timeout -1
spawn tizen package -t wgt -s scummvm -- /src/widget
expect "Author password:"
send -- "1234\r"
expect "Yes: (Y), No: (N) ?"
send -- "N\r"
expect eof
EOF
# tizen package names the file after <name> in config.xml.
cp /src/widget/*.wgt "/work/$WGT_NAME"
ls -la "/work/$WGT_NAME"
