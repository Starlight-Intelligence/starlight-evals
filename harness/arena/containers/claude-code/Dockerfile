# Contestant: Claude Code, headless (claude -p). Build from the starlight-evals root:
#   docker build -f harness/arena/containers/claude-code/Dockerfile -t starlight-arena/claude-code .
# Credential at run time only: ANTHROPIC_API_KEY. Nothing secret is baked into a layer.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash jq ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/pnpm PATH=/usr/local/pnpm:$PATH
RUN corepack enable pnpm && pnpm add -g @anthropic-ai/claude-code@2.1.303 && claude --version

# Claude Code refuses bypassPermissions as root, and nothing here needs root.
RUN useradd --create-home --uid 10001 arena && mkdir -p /out /pack && chown arena:arena /out /pack
COPY --chown=arena:arena harness/arena /arena/harness/arena
RUN chmod +x /arena/harness/arena/containers/entrypoint.sh
USER arena
WORKDIR /home/arena

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/arena/harness/arena/containers/entrypoint.sh"]
CMD ["--contestant", "claude-code", "--pack", "/pack", "--out", "/out"]
