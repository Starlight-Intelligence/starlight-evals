#!/bin/bash
# Contestant container entrypoint. Gets the pinned playbook pack (a mounted /pack, or a fetch with a
# read-only token that is dropped before any agent runs), runs the contestant, then uploads /out
# when the orchestrator handed in a presigned URL. Arguments pass straight to contestant.mjs.
set -euo pipefail

if [ ! -f /pack/evals/contract.json ]; then
  : "${PLAYBOOKS_READ_TOKEN:?no /pack mounted and no PLAYBOOKS_READ_TOKEN to fetch it}"
  : "${PLAYBOOKS_COMMIT:?PLAYBOOKS_COMMIT must pin the playbook commit}"
  # The token travels in git's environment config, never in argv, and is unset right after.
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: bearer ${PLAYBOOKS_READ_TOKEN}"
  git init -q /tmp/playbooks
  git -C /tmp/playbooks fetch -q --depth 1 https://github.com/Starlight-Intelligence/starlight-playbooks.git "$PLAYBOOKS_COMMIT"
  git -C /tmp/playbooks checkout -q FETCH_HEAD
  unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 PLAYBOOKS_READ_TOKEN
  mkdir -p /pack && cp -R /tmp/playbooks/playbooks/multi-agent-ops/. /pack/ && rm -rf /tmp/playbooks
fi
unset PLAYBOOKS_READ_TOKEN

status=0
node /arena/harness/arena/contestant.mjs "$@" || status=$?

if [ -n "${ARENA_UPLOAD_URL:-}" ]; then
  tar -czf /tmp/arena-out.tgz -C /out .
  curl --fail --silent --show-error -X PUT --upload-file /tmp/arena-out.tgz "$ARENA_UPLOAD_URL"
fi
exit "$status"
