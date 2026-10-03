#!/bin/sh
# Loads cel-js inside the real mod runtime. Copies mod-probe/ to a temp dir,
# bundles cel-js into it (as-is it fails: functions.js and registry.js import
# each other, which the mod loader rejects), then validates and tests it.
# The test is named .mod-test.ts here so the repo's own `claude plugin test`
# doesn't pick it up.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -r "$here/mod-probe/." "$tmp/"
mv "$tmp/tests/probe.mod-test.ts" "$tmp/tests/probe.test.ts"
mkdir -p "$tmp/hooks/vendor"
bun build "$here/node_modules/@marcbachmann/cel-js/lib/index.js" --format=esm --target=browser --outfile="$tmp/hooks/vendor/cel.js"
claude plugin validate "$tmp"
(cd "$tmp" && claude plugin test)
