#!/bin/sh
# Regenerate packages/claude-code/package-lock.json as a standalone lockfile (outside the npm workspace), which is
# what Claude Code uses to `npm ci` the plugin's dependency on the published jev-lens core. Run after the core is on npm.
set -e
cd "$(dirname "$0")/../packages/claude-code"
tmp=$(mktemp -d)
cp package.json "$tmp/"
(cd "$tmp" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund)
cp "$tmp/package-lock.json" package-lock.json
rm -rf "$tmp"
echo "wrote packages/claude-code/package-lock.json"
