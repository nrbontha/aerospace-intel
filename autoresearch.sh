#!/bin/bash
# JEv ladder bakeoff: scores the ladder variant in
# scripts/jev-ladder-variant.json against Booie's 29 labeled verdicts.
# Emits METRIC ladder_miss=N (lower is better).
set -euo pipefail
cd "$(dirname "$0")"
set -a; source .env.local 2>/dev/null; set +a
npx tsx scripts/jev-ladder-bakeoff.mts
