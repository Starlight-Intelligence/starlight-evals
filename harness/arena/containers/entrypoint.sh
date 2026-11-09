#!/bin/bash
# Contestant container entrypoint, run as root. Root gets the pinned playbook pack (a mounted /pack,
# or a fetch with a read-only token), runs the contestant supervisor with a cleaned environment, and
# uploads an allowlisted, scanned /out when the orchestrator handed in a presigned URL. The
# supervisor stays root and starts every agent as the unprivileged arena user (ARENA_AGENT_USER), so
# the agent can write neither /out, /pack nor the grader, and cannot read a root process's
# environment through /proc. Arguments pass straight to contestant.mjs.
set -euo pipefail

if [ ! -f /pack/evals/contract.json ]; then
  : "${PLAYBOOKS_READ_TOKEN:?no /pack mounted and no PLAYBOOKS_READ_TOKEN to fetch it}"
  : "${PLAYBOOKS_COMMIT:?PLAYBOOKS_COMMIT must pin the playbook commit}"
  # The token travels in git's environment config, never in argv.
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: bearer ${PLAYBOOKS_READ_TOKEN}"
  git init -q /tmp/playbooks
  git -C /tmp/playbooks fetch -q --depth 1 https://github.com/Starlight-Intelligence/starlight-playbooks.git "$PLAYBOOKS_COMMIT"
  git -C /tmp/playbooks checkout -q FETCH_HEAD
  unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
  mkdir -p /pack && cp -R /tmp/playbooks/playbooks/multi-agent-ops/. /pack/ && rm -rf /tmp/playbooks
fi
# Readable by the agent (its gh simulator runs from the pack), writable by nobody but root.
chown -R root:root /pack 2>/dev/null || true
chmod -R a+rX,go-w /pack 2>/dev/null || true
chown root:root /out && chmod 0755 /out

# The supervisor sees the toolchain, its contestant's credentials (ARENA_CRED_NAMES, set per image)
# and the arena markers. The playbook token and the upload URL are unset before it starts.
status=0
(
  keep=" PATH LANG TZ XDG_CACHE_HOME ARENA_RUNTIME ARENA_AGENT_USER ARENA_GRADER_USER ${ARENA_CRED_NAMES:-} "
  for name in $(compgen -e); do
    case "$keep" in *" $name "*) ;; *) unset "$name" ;; esac
  done
  export HOME=/root
  exec node /arena/harness/arena/contestant.mjs "$@"
) || status=$?

# Every bundle is scanned, uploaded or not: a credential value anywhere under /out fails the run.
node /arena/harness/arena/containers/scan-out.mjs /out || exit 3

if [ -n "${ARENA_UPLOAD_URL:-}" ]; then
  # Only files the supervisor writes leave the container.
  tar -czf /tmp/arena-out.tgz -C /out contestant.json $(cd /out && ls trials.jsonl 2>/dev/null) $(cd /out && ls -d transcripts 2>/dev/null)
  # The presigned URL is a bearer credential: curl reads it from its config on stdin, not argv.
  printf 'url = "%s"\n' "$ARENA_UPLOAD_URL" | curl --fail --silent --show-error -X PUT --upload-file /tmp/arena-out.tgz --config -
fi
exit "$status"
