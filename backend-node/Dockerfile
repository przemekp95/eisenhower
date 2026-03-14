# Build stage
FROM node:20-alpine AS build

ENV NODE_ENV=development
WORKDIR /app/backend-node

COPY backend-node/package.json backend-node/package-lock.json ./
COPY packages/api-client/package.json ../packages/api-client/package.json
COPY packages/api-client/index.js ../packages/api-client/index.js
COPY packages/api-client/index.d.ts ../packages/api-client/index.d.ts
RUN npm ci --no-audit --no-fund

COPY backend-node ./
COPY packages/api-client ../packages/api-client
RUN npm run build && npm prune --omit=dev

# Production stage
FROM node:20-alpine AS production

ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

RUN apk add --no-cache curl \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nextjs -u 1001

COPY --from=build /app/backend-node/package.json ./package.json
COPY --from=build /app/backend-node/package-lock.json ./package-lock.json
COPY --from=build /app/backend-node/node_modules ./node_modules
COPY --from=build /app/backend-node/dist ./dist

USER nextjs

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3001/health/ready || exit 1

EXPOSE 3001

CMD ["node", "dist/server.js"]

# Development stage
FROM node:20-alpine AS development

WORKDIR /app/backend-node

RUN apk add --no-cache curl

COPY backend-node/package.json backend-node/package-lock.json ./
COPY packages/api-client/package.json ../packages/api-client/package.json
COPY packages/api-client/index.js ../packages/api-client/index.js
COPY packages/api-client/index.d.ts ../packages/api-client/index.d.ts
RUN npm ci --no-audit --no-fund

COPY backend-node ./
COPY packages/api-client ../packages/api-client

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3001/health/ready || exit 1

EXPOSE 3001

CMD ["npm", "run", "dev"]
