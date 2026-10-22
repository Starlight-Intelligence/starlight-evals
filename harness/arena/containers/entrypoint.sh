#!/bin/bash
# Contestant container entrypoint, run as root. Root takes ownership of /out, gets the pinned
# playbook pack (a mounted /pack, or a fetch with a read-only token), runs the contestant as the
# unprivileged arena user with a cleaned environment, and uploads /out when the orchestrator handed
# in a presigned URL. The contestant cannot read this shell's environment: /proc/<pid>/environ of a
# root process is closed to another uid. Arguments pass straight to contestant.mjs.
set -euo pipefail

chown arena:arena /out

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
  chmod -R a+rX /pack
fi

# The contestant sees only the toolchain, its own credentials (ARENA_CRED_NAMES, set per image)
# and the arena marker. Everything else, the playbook token and upload URL included, is unset in
# the subshell before it execs into the arena user.
status=0
(
  keep=" PATH LANG TZ XDG_CACHE_HOME ARENA_RUNTIME ${ARENA_CRED_NAMES:-} "
  for name in $(compgen -e); do
    case "$keep" in *" $name "*) ;; *) unset "$name" ;; esac
  done
  export HOME=/home/arena
  exec setpriv --reuid=arena --regid=arena --init-groups --no-new-privs node /arena/harness/arena/contestant.mjs "$@"
) || status=$?

if [ -n "${ARENA_UPLOAD_URL:-}" ]; then
  tar -czf /tmp/arena-out.tgz -C /out .
  # The presigned URL is a bearer credential: curl reads it from its config on stdin, not argv.
  printf 'url = "%s"\n' "$ARENA_UPLOAD_URL" | curl --fail --silent --show-error -X PUT --upload-file /tmp/arena-out.tgz --config -
fi
exit "$status"
