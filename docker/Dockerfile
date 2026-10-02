FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 COREPACK_HOME=/opt/corepack
RUN apk upgrade --no-cache && apk add --no-cache openssl ca-certificates && corepack enable

FROM base AS build
COPY . .
RUN yarn install --immutable && yarn generate && yarn build

FROM build AS production-dependencies
RUN yarn workspaces focus @getexception/web @getexception/ingest @getexception/worker --production

FROM build AS migration-dependencies
RUN yarn workspaces focus @getexception/migrate --production

FROM base AS runtime-base
ENV NODE_ENV=production
RUN mkdir -p /var/lib/getexception/source-maps && chown node:node /var/lib/getexception/source-maps && chmod 700 /var/lib/getexception/source-maps
# Package managers are build tools; none of the deployed processes needs them.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* /opt/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx

FROM runtime-base AS runtime
COPY --from=production-dependencies --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/package.json /app/LICENSE /app/
COPY --from=build --chown=node:node /app/apps/web/.next /app/apps/web/.next
COPY --from=build --chown=node:node /app/apps/web/dist /app/apps/web/dist
COPY --from=build --chown=node:node /app/apps/web/package.json /app/apps/web/THIRD-PARTY-NOTICES.md /app/apps/web/
COPY --from=build --chown=node:node /app/apps/ingest/dist /app/apps/ingest/dist
COPY --from=build --chown=node:node /app/apps/worker/dist /app/apps/worker/dist
COPY --chown=node:node docker/next.config.mjs /app/apps/web/next.config.mjs
USER node

FROM runtime AS web
CMD ["node", "apps/web/dist/start.js"]
FROM runtime AS ingest
CMD ["node", "apps/ingest/dist/main.js"]
FROM runtime AS worker
CMD ["node", "apps/worker/dist/main.js"]
FROM runtime-base AS migrate
COPY --from=migration-dependencies --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/package.json /app/LICENSE /app/
COPY --from=build --chown=node:node /app/prisma.config.ts /app/prisma.config.ts
COPY --from=build --chown=node:node /app/packages/db/prisma /app/packages/db/prisma
COPY --from=build --chown=node:node /app/apps/migrate/dist /app/apps/migrate/dist
USER node
CMD ["node", "apps/migrate/dist/main.js"]

# Upstream's signed release is available before its official Docker image.
# Keep only the static binary and CA roots; no shell, apk or system zlib at runtime.
FROM base AS caddy-binary
ADD --checksum=sha256:22c84f8d2d4e4e0e2d422f8049fdd0fc1ed8d5665d0fe166f506c7fd863b4555 https://github.com/caddyserver/caddy/releases/download/v2.11.6/caddy_2.11.6_linux_amd64.tar.gz /tmp/caddy.tar.gz
RUN mkdir -p /caddy/data /caddy/config && tar -xzf /tmp/caddy.tar.gz -C /caddy caddy LICENSE

FROM scratch AS caddy
ENV PATH=/usr/bin XDG_CONFIG_HOME=/config XDG_DATA_HOME=/data
COPY --from=caddy-binary /caddy/caddy /usr/bin/caddy
COPY --from=caddy-binary /caddy/LICENSE /usr/share/licenses/caddy/LICENSE
COPY --from=caddy-binary /caddy/data /data
COPY --from=caddy-binary /caddy/config /config
COPY --from=caddy-binary /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /srv
EXPOSE 80 443
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
