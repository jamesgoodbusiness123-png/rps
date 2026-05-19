FROM node:20-alpine

RUN apk add --no-cache docker-cli bash curl ca-certificates tini

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js index.html ./
RUN mkdir -p /app/data/local_storage/excel /app/data/local_storage/access /app/data/exports \
    && addgroup -S logiflow \
    && adduser -S logiflow -G logiflow \
    && chown -R logiflow:logiflow /app

USER logiflow
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
