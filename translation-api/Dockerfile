FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY sql ./sql
COPY src ./src
COPY public ./public

RUN npm run build

FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/sql ./sql

EXPOSE 5000

CMD ["node", "dist/index.js"]
