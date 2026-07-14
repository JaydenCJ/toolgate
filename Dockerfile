# Build and run toolgate. Base image is pinned; no :latest tags.
FROM node:22.12.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.12.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY examples ./examples
# Default command is overridden by docker-compose; kept here for docker run.
CMD ["node", "dist/cli.js", "--help"]
