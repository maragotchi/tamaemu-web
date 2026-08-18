#!/bin/sh
set -e
cd "$(dirname "$0")/.."

[ -f build/tamaemu.wasm ] || { echo "build/tamaemu.wasm missing - run ./build.sh first"; exit 1; }
[ -f build/tamaemu.mjs ] || { echo "build/tamaemu.mjs missing - run ./build.sh first"; exit 1; }

rm -rf dist
mkdir -p dist
cp build/tamaemu.mjs build/tamaemu.wasm dist/

for f in web/*; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in
        index.html|states.html) continue ;;
    esac
    cp "$f" dist/
done

: > dist/.nojekyll
sed 's#\.\./build/tamaemu\.mjs#./tamaemu.mjs#' web/index.html > dist/index.html
grep -q "'./tamaemu.mjs'" dist/index.html
! grep -q '\.\./' dist/index.html

echo "dist contents:"
ls -la dist
echo "size summary:"
du -sh dist
