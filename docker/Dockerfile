FROM node:24.20.0-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS base
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
# Package managers are build tools; none of the deployed processes needs them.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* /opt/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx

FROM runtime-base AS runtime
COPY --from=production-dependencies --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/package.json /app/package.json
COPY --from=build --chown=node:node /app/apps/web/.next /app/apps/web/.next
COPY --from=build --chown=node:node /app/apps/web/dist /app/apps/web/dist
COPY --from=build --chown=node:node /app/apps/web/package.json /app/apps/web/package.json
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
FROM runtime AS mail
CMD ["node", "apps/worker/dist/mail.js"]
FROM runtime-base AS migrate
COPY --from=migration-dependencies --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/package.json /app/package.json
COPY --from=build --chown=node:node /app/prisma.config.ts /app/prisma.config.ts
COPY --from=build --chown=node:node /app/packages/db/prisma /app/packages/db/prisma
COPY --from=build --chown=node:node /app/apps/migrate/dist /app/apps/migrate/dist
USER node
CMD ["node", "apps/migrate/dist/main.js"]
