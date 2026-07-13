# Root Dockerfile for Render when the service builds from the repo root
# (e.g. "New Web Service" → Se-babe/Ugajapa-Bot). Blueprint uses translation-api/Dockerfile instead.
FROM node:22-slim AS builder

WORKDIR /app

COPY translation-api/package.json translation-api/package-lock.json* ./
RUN npm install

COPY translation-api/tsconfig.json ./
COPY translation-api/sql ./sql
COPY translation-api/src ./src
COPY translation-api/public ./public

RUN npm run build

FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

COPY translation-api/package.json translation-api/package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/sql ./sql

EXPOSE 5000

CMD ["node", "dist/index.js"]
