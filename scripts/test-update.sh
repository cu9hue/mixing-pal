#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log_dir="$repo_root/.superpowers/updates"
mkdir -p "$log_dir"
log_file="$log_dir/rehearsal-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"

echo "Running isolated local updater mechanics test; log: $log_file"
if (cd "$repo_root/src-tauri" && cargo test updates::rehearsal -- --nocapture) >"$log_file" 2>&1; then
  tail -30 "$log_file"
else
  tail -60 "$log_file"
  exit 1
fi
