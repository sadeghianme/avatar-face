# Liveface dashboard image. Build context = repo root:
#   docker build -f frontend/Dockerfile .
# The frontend imports the embed engine from ../embed/src, so both packages
# are installed in the build stage. Base images are pinned by digest
# (docs/process.md says how to move them).

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /build
COPY embed/package.json embed/package-lock.json embed/tsconfig.json ./embed/
RUN cd embed && npm ci
COPY embed/src ./embed/src
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

FROM nginx:1.30-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /build/frontend/dist /usr/share/nginx/html

# The commit this image was built from (deploy/deploy.sh passes it), served
# at /version.json so the deploy can prove the new dashboard is the one
# answering. Last, so a new commit rebuilds only these small layers.
ARG LIVEFACE_VERSION=dev
RUN printf '{"version":"%s"}\n' "$LIVEFACE_VERSION" > /usr/share/nginx/html/version.json \
 && nginx -t
LABEL org.opencontainers.image.revision=$LIVEFACE_VERSION \
      org.opencontainers.image.source=https://github.com/sadeghianme/avatar-face
EXPOSE 80
