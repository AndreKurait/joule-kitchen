FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS mock
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
