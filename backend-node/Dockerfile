# Build stage
FROM cgr.dev/chainguard/wolfi-base@sha256:a31344ab2cb8618db84f535eec56f76f6178b142cb92cb2e48676cc2dcebea72 AS build

USER root
RUN apk add --no-cache \
      nodejs-24=24.19.0-r0 \
      npm=12.0.2-r0

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
FROM cgr.dev/chainguard/wolfi-base@sha256:a31344ab2cb8618db84f535eec56f76f6178b142cb92cb2e48676cc2dcebea72 AS production

ARG RELEASE_SHA
LABEL org.opencontainers.image.revision=$RELEASE_SHA

USER root
RUN apk add --no-cache nodejs-24-minimal=24.19.0-r0
ADD --checksum=sha256:56a0cae044b6cc433971d964347401692a92ea0294e392753a3ebdaee54d8b84 https://truststore.pki.rds.amazonaws.com/eu-central-1/eu-central-1-bundle.pem /etc/ssl/certs/aws-rds-eu-central-1-bundle.pem
RUN chmod 0444 /etc/ssl/certs/aws-rds-eu-central-1-bundle.pem

ENV NODE_ENV=production
ENV PORT=3001
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-eu-central-1-bundle.pem

WORKDIR /app

COPY --from=build --chown=65532:65532 /app/backend-node/package.json ./package.json
COPY --from=build --chown=65532:65532 /app/backend-node/package-lock.json ./package-lock.json
COPY --from=build --chown=65532:65532 /app/backend-node/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/backend-node/dist ./dist
COPY --from=build --chown=65532:65532 /app/backend-node/prisma ./prisma

USER 65532:65532

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

EXPOSE 3001

CMD ["node", "dist/server.js"]

# Development stage
FROM build AS development

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

EXPOSE 3001

CMD ["npm", "run", "dev"]
