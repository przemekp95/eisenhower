# Build stage
FROM node:20-alpine AS build

WORKDIR /app/web

COPY web/package.json web/package-lock.json ./
COPY packages/api-client/package.json ../packages/api-client/package.json
COPY packages/api-client/index.js ../packages/api-client/index.js
COPY packages/api-client/index.d.ts ../packages/api-client/index.d.ts
RUN npm ci --no-audit --no-fund

COPY web ./
COPY packages/api-client ../packages/api-client
RUN npm run build

# Production stage
FROM nginx:alpine AS production

RUN apk add --no-cache curl && \
    mkdir -p /var/cache/nginx /tmp/nginx && \
    chown -R nginx:nginx /var/cache/nginx /tmp/nginx /usr/share/nginx/html

COPY web/nginx.conf /etc/nginx/nginx.conf
COPY web/docker-entrypoint.sh /docker-entrypoint.sh
COPY --from=build /app/web/dist /usr/share/nginx/html

RUN chown -R nginx:nginx /etc/nginx/nginx.conf /usr/share/nginx/html /docker-entrypoint.sh && \
    chmod 755 /docker-entrypoint.sh

USER nginx

ENV VITE_API_URL=/api
ENV VITE_AI_API_URL=/ai

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

CMD ["/docker-entrypoint.sh"]

# Development stage
FROM node:20-alpine AS development

WORKDIR /app/web
RUN chown node:node /app /app/web

USER node

COPY --chown=node:node web/package.json web/package-lock.json ./
COPY --chown=node:node packages/api-client/package.json ../packages/api-client/package.json
COPY --chown=node:node packages/api-client/index.js ../packages/api-client/index.js
COPY --chown=node:node packages/api-client/index.d.ts ../packages/api-client/index.d.ts
RUN npm ci --no-audit --no-fund

COPY --chown=node:node web ./
COPY --chown=node:node packages/api-client ../packages/api-client

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://localhost:5173/ >/dev/null || exit 1

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
