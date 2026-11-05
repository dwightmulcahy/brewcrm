# syntax=docker/dockerfile:1
FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
WORKDIR /app
COPY scripts ./scripts
COPY src ./src
RUN node scripts/build.mjs web

FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Files owned by root, process runs as non-root: app cannot modify itself
COPY --from=build /app/dist/web ./public
COPY server.mjs ./
# Static runtime needs node, not npm/corepack or their vulnerable bundled packages.
# Keep package managers in the build stage only.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.mjs"]
