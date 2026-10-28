FROM node:22-alpine

RUN apk add --no-cache git tini

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    LIVE_DIR=/srv/chassette

COPY package.json ./
COPY server.js updater.js sources.json ./
COPY lib ./lib
COPY public ./public

ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}

RUN mkdir -p /srv/chassette && chown node:node /srv/chassette
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "updater.js"]
