#!/usr/bin/env sh
# Download 1300 OpenHands trajectories from Hugging Face and convert them for the benchmark.
# Output: eval/bench/openhands.jsonl (about 300 MB; git-ignored). Slices: 0-199 train, 200-299 holdout,
# 300-799 large holdout, 800-1299 untouched reserve.
set -e
cd "$(dirname "$0")"
for off in 0 100 200 300 400 500 600 700 800 900 1000 1100 1200; do
  curl -s --retry 3 "https://datasets-server.huggingface.co/rows?dataset=nebius/SWE-rebench-openhands-trajectories&config=default&split=train&offset=$off&length=100" -o rows-$off.json
done
# explicit order: a glob would sort rows-1000 before rows-200 and scramble the slices
node --import tsx convert-openhands.ts rows-0.json rows-100.json rows-200.json rows-300.json rows-400.json rows-500.json rows-600.json rows-700.json rows-800.json rows-900.json rows-1000.json rows-1100.json rows-1200.json > openhands.jsonl
wc -l openhands.jsonl
