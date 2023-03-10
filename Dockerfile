FROM node:18 as builder

COPY ./ /build
WORKDIR /build

RUN npm install -g pnpm && \
    pnpm install && \
    pnpm run build

FROM node:18-alpine as production

WORKDIR /app
ARG GIT_SHA
ENV GIT_SHA=${GIT_SHA}
ENV PORT=8899

RUN npm install -g pm2@5.2.2

COPY --from=builder /build/dist ./
COPY --from=builder /build/ecosystem.config.js ./

EXPOSE ${PORT}

CMD ["pm2-runtime", "ecosystem.config.js"]
HEALTHCHECK --start-period=30s --retries=2 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1