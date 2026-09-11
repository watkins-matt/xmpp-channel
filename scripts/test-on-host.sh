#!/usr/bin/env bash
# Run the fork's tests and build against a gateway host's REAL OpenClaw SDK.
#
# The plugin no longer bundles its own copy of `openclaw` (the 2026.2.2 copy it
# used to pull in validated the live config against a months-old schema and
# spammed "Invalid config" on every gateway start). `openclaw` is an optional
# peer: on a gateway, node_modules/openclaw is a symlink to the installed
# package, exactly what the ansible xmpp.yml deploy sets up. This script
# reproduces that in a scratch copy on the host, so local changes are tested
# against the SDK they will actually run inside.
#
# Usage: scripts/test-on-host.sh [host]    (default: openclaw-keep)
set -euo pipefail

host="${1:-openclaw-keep}"
target="root@${host%.lxc}.lxc"
dest="/tmp/xmpp-channel-test"
repo="$(cd "$(dirname "$0")/.." && pwd)"

rsync -a --delete --exclude node_modules --exclude dist --exclude .git \
  "${repo}/" "${target}:${dest}/"

ssh "${target}" "set -e
  cd '${dest}'
  nice -n 10 npm install --no-audit --no-fund >/dev/null
  rm -rf node_modules/openclaw
  ln -s /usr/lib/node_modules/openclaw node_modules/openclaw
  echo \"host OpenClaw: \$(node -p \"require('/usr/lib/node_modules/openclaw/package.json').version\")\"
  nice -n 10 npm test -- --run
  nice -n 10 npm run build >/dev/null && echo 'tsc build: ok'"
