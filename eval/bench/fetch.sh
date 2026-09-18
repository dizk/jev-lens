#!/usr/bin/env sh
# Download 300 OpenHands trajectories from Hugging Face and convert them for the benchmark.
# Output: eval/bench/openhands.jsonl (about 70 MB; git-ignored).
set -e
cd "$(dirname "$0")"
for off in 0 100 200; do
  curl -s "https://datasets-server.huggingface.co/rows?dataset=nebius/SWE-rebench-openhands-trajectories&config=default&split=train&offset=$off&length=100" -o rows-$off.json
done
node --import tsx convert-openhands.ts rows-0.json rows-100.json rows-200.json > openhands.jsonl
wc -l openhands.jsonl
