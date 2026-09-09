FROM node:24.4.0-bookworm-slim@sha256:1b044a60874f1b57ac8c4e708ddb3a00e55b34586ebbacce09a48796dafcc799 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 COREPACK_HOME=/opt/corepack
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable

FROM base AS build
COPY . .
RUN yarn install --immutable && yarn generate && yarn build

FROM build AS production-dependencies
RUN yarn workspaces focus @getexception/web @getexception/ingest @getexception/worker --production

FROM base AS runtime
ENV NODE_ENV=production
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
FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["yarn", "migrate:run"]
