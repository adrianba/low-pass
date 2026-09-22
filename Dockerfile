ARG NODE_IMAGE=node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --min-release-age=7 --no-audit --no-fund
COPY . .
RUN npm run build && npm run build:server
RUN wget -q -O /node-LICENSE "https://raw.githubusercontent.com/nodejs/node/$(node --version)/LICENSE"

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --min-release-age=7 --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
WORKDIR /opt/low-pass
RUN addgroup -g 101 lowpass && adduser -D -H -u 101 -G lowpass lowpass
ENV NODE_ENV=production \
    LOW_PASS_SERVICE_HOST=0.0.0.0 \
    LOW_PASS_SERVICE_PORT=8080 \
    LOW_PASS_STATIC_ROOT=/opt/low-pass/dist
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./dist
COPY --from=build /node-LICENSE ./dist/licenses/node.txt
COPY package.json package-lock.json ./
USER 101:101
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/opt/low-pass/dist-server/server/index.js"]
CMD []
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "/opt/low-pass/dist-server/server/healthcheck.js"]
