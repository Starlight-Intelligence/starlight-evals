# Contestant: OpenCode with Oh My OpenCode (omo) in ultrawork mode, on open models via OpenRouter.
# Build from the starlight-evals root:
#   docker build -f harness/arena/containers/opencode-omo/Dockerfile -t starlight-arena/opencode-omo .
# Credential at run time only: OPENROUTER_API_KEY. Data class 1 tasks only (arena.config.json).
#
# oh-my-opencode is pinned to 2.5.1, its last MIT release, fetched from the npm registry whose
# tarball integrity is checked below. Upstream (github.com/code-yeongyu/oh-my-openagent) moved to
# SUL-1.0 the next day. Never install from ohmyopencode.com or the get.omo.dev script.
# omo runs here only as a contestant inside its own container, never as an orchestrator.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash jq ca-certificates curl tini unzip \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/pnpm PATH=/usr/local/pnpm:$PATH
RUN corepack enable pnpm && pnpm add -g opencode-ai@1.0.162 && opencode --version

# OpenCode installs the plugin named in opencode.json (oh-my-opencode@2.5.1) into its cache at the
# first trial, and the registry checks that tarball's integrity. The image-owned cache keeps every
# later trial on those same bytes. The tarball fetched here is checked against the integrity the
# registry published for 2.5.1 on 2026-10-22 and kept in /opt/omo, so a build fails if 2.5.1 ever
# resolves to different bytes. Loading the plugin from /opt/omo instead of by name is unverified.
ENV XDG_CACHE_HOME=/opt/arena-cache
RUN mkdir -p /opt/arena-cache /opt/omo && cd /opt/omo \
 && npm pack oh-my-opencode@2.5.1 --silent \
 && node -e "const c=require('crypto'),f=require('fs');const h='sha512-'+c.createHash('sha512').update(f.readFileSync('oh-my-opencode-2.5.1.tgz')).digest('base64');if(h!=='sha512-D4zcgVQsA9KGo9cJuqQ2JFSwzZxwmiHYlW6eAyvkSJ3KS/ZgOg7AbG3mu+3Vt45Ovuo2DKBoYi3hWfECbkP5hQ=='){console.error('oh-my-opencode 2.5.1 tarball integrity mismatch');process.exit(1)}"

# arena runs the agent; arena-grader runs the playbook's grader over candidate code; neither holds a credential the other needs.
RUN useradd --create-home --uid 10001 arena && useradd --uid 10002 arena-grader && mkdir -p /out /pack && chown -R arena:arena /opt/arena-cache
# Root-owned, so the agent (arena user) cannot rewrite the runner it is measured by.
COPY harness/arena /arena/harness/arena
RUN chmod +x /arena/harness/arena/containers/entrypoint.sh
# The supervisor stays root; every agent runs as the arena user, which owns only its sandbox.
ENV ARENA_RUNTIME=container ARENA_AGENT_USER=arena ARENA_GRADER_USER=arena-grader ARENA_CRED_NAMES=OPENROUTER_API_KEY
WORKDIR /home/arena

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/arena/harness/arena/containers/entrypoint.sh"]
CMD ["--contestant", "opencode-omo", "--pack", "/pack", "--out", "/out"]
