# syntax=docker/dockerfile:1
FROM node:26.13.0-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
# PocketBase is fetched from the official GitHub release and verified against the
# release's checksums.txt. Bump PB_VERSION deliberately (not tracked by Dependabot).
ARG PB_VERSION=0.40.6
ARG TARGETARCH
WORKDIR /src
RUN set -eu; \
    arch="${TARGETARCH:-amd64}"; \
    base="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}"; \
    zip="pocketbase_${PB_VERSION}_linux_${arch}.zip"; \
    wget -q "${base}/${zip}" "${base}/checksums.txt"; \
    grep " ${zip}\$" checksums.txt > expected.sha256; \
    test -s expected.sha256; \
    sha256sum -c expected.sha256; \
    unzip -q "${zip}" pocketbase -d /out; \
    chmod 0755 /out/pocketbase
COPY package.json Dockerfile ./
COPY scripts ./scripts
COPY pb_public ./pb_public
COPY pb_hooks ./pb_hooks
COPY pb_migrations ./pb_migrations
RUN OUT_DIR=/out/app node scripts/build.mjs web

FROM node:26.13.0-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
ENV PORT=8080 TZ=UTC
WORKDIR /app
# Runtime is the static PocketBase binary; drop Node and package managers entirely.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/include/node /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && apk add --no-cache ca-certificates tzdata \
 && mkdir -p /data && chown node:node /data
# Files owned by root, process runs as non-root: app cannot modify itself
COPY --from=build /out/pocketbase ./pocketbase
COPY --from=build /out/app/pb_public ./pb_public
COPY --from=build /out/app/pb_hooks ./pb_hooks
COPY --from=build /out/app/pb_migrations ./pb_migrations
COPY --from=build /out/app/build.json ./build.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
