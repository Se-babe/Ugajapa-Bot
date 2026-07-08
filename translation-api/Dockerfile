FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY sql ./sql
COPY src ./src

RUN npx tsc

EXPOSE 5000

CMD ["node", "dist/index.js"]
