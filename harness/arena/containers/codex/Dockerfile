# Contestant: Codex CLI, headless (codex exec --json). Build from the starlight-evals root:
#   docker build -f harness/arena/containers/codex/Dockerfile -t starlight-arena/codex .
# Credential at run time only: OPENAI_API_KEY. The container is the sandbox, so codex runs with
# its own sandbox bypassed, the case that flag is documented for.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash jq ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/pnpm PATH=/usr/local/pnpm:$PATH
RUN corepack enable pnpm && pnpm add -g @openai/codex@0.163.0 && codex --version

RUN useradd --create-home --uid 10001 arena && mkdir -p /out /pack && chown arena:arena /out /pack
COPY --chown=arena:arena harness/arena /arena/harness/arena
RUN chmod +x /arena/harness/arena/containers/entrypoint.sh
USER arena
WORKDIR /home/arena

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/arena/harness/arena/containers/entrypoint.sh"]
CMD ["--contestant", "codex", "--pack", "/pack", "--out", "/out"]
