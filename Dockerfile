# Root Dockerfile for Render when the service builds from the repo root
# (e.g. "New Web Service" → Se-babe/Ugajapa-Bot). Blueprint uses translation-api/Dockerfile instead.
FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

COPY translation-api/package.json translation-api/package-lock.json* ./
RUN npm install

COPY translation-api/tsconfig.json ./
COPY translation-api/sql ./sql
COPY translation-api/src ./src
COPY translation-api/public ./public

RUN npx tsc

EXPOSE 5000

CMD ["node", "dist/index.js"]
