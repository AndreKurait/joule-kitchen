FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS mock
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules/ws ./node_modules/ws
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/types.ts ./src/types.ts
COPY src/uuid.ts ./src/uuid.ts
COPY src/device/protocol.ts ./src/device/protocol.ts
COPY mock ./mock
USER node
EXPOSE 4173
HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--experimental-strip-types", "mock/server.ts"]
