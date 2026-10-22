# Contestant: Claude Code, headless (claude -p). Build from the starlight-evals root:
#   docker build -f harness/arena/containers/claude-code/Dockerfile -t starlight-arena/claude-code .
# Credential at run time only: ANTHROPIC_API_KEY. Nothing secret is baked into a layer.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash jq ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/pnpm PATH=/usr/local/pnpm:$PATH
RUN corepack enable pnpm && pnpm add -g @anthropic-ai/claude-code@2.1.303 && claude --version

# Claude Code refuses bypassPermissions as root; the agent always runs as the arena user.
# arena runs the agent; arena-grader runs the playbook's grader over candidate code; neither holds a credential the other needs.
RUN useradd --create-home --uid 10001 arena && useradd --uid 10002 arena-grader && mkdir -p /out /pack
# Root-owned, so the agent (arena user) cannot rewrite the runner it is measured by.
COPY harness/arena /arena/harness/arena
RUN chmod +x /arena/harness/arena/containers/entrypoint.sh
# The supervisor stays root; every agent runs as the arena user, which owns only its sandbox.
ENV ARENA_RUNTIME=container ARENA_AGENT_USER=arena ARENA_GRADER_USER=arena-grader ARENA_CRED_NAMES=ANTHROPIC_API_KEY
WORKDIR /home/arena

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/arena/harness/arena/containers/entrypoint.sh"]
CMD ["--contestant", "claude-code", "--pack", "/pack", "--out", "/out"]
