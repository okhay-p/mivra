# syntax=docker/dockerfile:1
# Mivra in a container (ADR-013): the published npm package, run as the unprivileged `node` user.
#
#   docker build -t ghcr.io/okhay-p/mivra:0.1.1 --build-arg MIVRA_PACKAGE=@okhay-p/mivra@0.1.1 docker
#
# To try an unreleased build, `npm pack` packages/mivra into docker/ and pass the tarball instead:
#   --build-arg MIVRA_PACKAGE=/tmp/context/okhay-p-mivra-0.1.1.tgz
FROM node:22-bookworm-slim

ARG MIVRA_PACKAGE=@okhay-p/mivra@latest
COPY . /tmp/context/
RUN npm install --global --omit=dev --no-audit --no-fund --loglevel=error "$MIVRA_PACKAGE" \
  && npm cache clean --force \
  && rm -rf /tmp/context \
  && mkdir -p /data && chown node:node /data

# Inside the container the server must listen beyond loopback to be reachable through a published port; publish it on
# the host's 127.0.0.1 (`-p 127.0.0.1:4096:4096`) so it stays local there. The port is fixed, never swapped for another.
ENV MIVRA_DATA_DIR=/data \
    MIVRA_HOST=0.0.0.0 \
    MIVRA_PORT=4096 \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

USER node
VOLUME /data
EXPOSE 4096
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.MIVRA_PORT}/api/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

LABEL org.opencontainers.image.title="Mivra" \
      org.opencontainers.image.description="A local-first AI tutor that teaches with interactive visualizations, checks and courses." \
      org.opencontainers.image.source="https://github.com/okhay-p/mivra" \
      org.opencontainers.image.licenses="MIT"

CMD ["mivra", "start", "--no-open"]
