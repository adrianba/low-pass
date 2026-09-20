ARG NODE_IMAGE=node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:stable-alpine@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run build:server
RUN wget -q -O /node-LICENSE "https://raw.githubusercontent.com/nodejs/node/$(node --version)/LICENSE"
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NGINX_IMAGE}
USER root
RUN apk add --no-cache 's6>=2.15.0.0' s6-doc skalibs-doc execline-doc libstdc++
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/dist-server /opt/low-pass/server
COPY --from=build /app/node_modules /opt/low-pass/node_modules
ENV LOW_PASS_STATIC_ROOT=/usr/share/nginx/html
COPY package.json /opt/low-pass/package.json
COPY container/ /etc/low-pass/
RUN chmod 755 /etc/low-pass/entrypoint /etc/low-pass/services/nginx/run \
    /etc/low-pass/services/nginx/finish /etc/low-pass/services/node/run \
    /etc/low-pass/services/node/finish
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /node-LICENSE /usr/share/nginx/html/licenses/node.txt
RUN cp /usr/share/licenses/s6/COPYING /usr/share/nginx/html/licenses/s6.txt \
    && cp /usr/share/licenses/skalibs/COPYING /usr/share/nginx/html/licenses/skalibs.txt \
    && cp /usr/share/licenses/execline/COPYING /usr/share/nginx/html/licenses/execline.txt \
    && cp /usr/share/licenses/nginx/COPYRIGHT /usr/share/nginx/html/licenses/nginx.txt \
    && test "$(node -p 'process.versions.node.split(".")[0]')" = 24 \
    && nginx -t
USER 101:101
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/etc/low-pass/entrypoint"]
CMD []
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
