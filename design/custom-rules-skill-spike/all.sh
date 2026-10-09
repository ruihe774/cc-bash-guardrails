#!/bin/bash
# all.sh <case>... : copies the plugin (hooks, skills, manifest only: no CLAUDE.md, README, design or tests)
# into ./plugin, then runs every case with Haiku and Sonnet in parallel. Grade with: python3 grade.py
SP=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SP/../.." && pwd)
rm -rf "$SP/plugin" && mkdir -p "$SP/plugin/.claude-plugin"
cp "$ROOT/plugin/.claude-plugin/plugin.json" "$SP/plugin/.claude-plugin/" && cp -r "$ROOT/plugin/hooks" "$ROOT/plugin/skills" "$SP/plugin/"
setup() { [ -d "$SP/setups/$1" ] && echo "$SP/setups/$1"; }
cases=("$@"); [ ${#cases[@]} -gt 0 ] || cases=($(cd "$SP/cases" && ls | sed 's/\.txt$//'))
for m in haiku sonnet; do for c in "${cases[@]}"; do "$SP/run.sh" "$c" "$m" "$SP/cases/$c.txt" $(setup "$c") & done; done
wait
