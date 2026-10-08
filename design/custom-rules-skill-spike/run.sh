#!/bin/bash
# run.sh <case> <model> <prompt-file> [setup-dir]
SP=$(cd "$(dirname "$0")" && pwd)
case=$1; model=$2; prompt=$(cat "$3"); setup=$4
d=$SP/runs/$case-$model
rm -rf "$d"; mkdir -p "$d/home/.claude" "$d/proj"
[ -n "$setup" ] && cp -rT "$setup" "$d"
cd "$d/proj" && git init -q . 2>/dev/null
timeout 900 env -i HOME="$d/home" PATH="$PATH" IS_SANDBOX=1 ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" HTTPS_PROXY="$HTTPS_PROXY" HTTP_PROXY="$HTTP_PROXY" NO_PROXY="$NO_PROXY" NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS" SSL_CERT_FILE="$SSL_CERT_FILE" \
  claude -p "$prompt" --model "claude-$model-5-5" --plugin-dir "$SP/plugin" --permission-mode bypassPermissions \
  --output-format stream-json --verbose < /dev/null > "$d/log.jsonl" 2> "$d/stderr.txt"
echo "$case-$model exit=$?"
