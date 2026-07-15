# Liveface dashboard image. Build context = repo root:
#   docker build -f frontend/Dockerfile .
# The frontend imports the embed engine from ../embed/src, so both packages
# are installed in the build stage.

FROM node:20-alpine AS build
WORKDIR /build
COPY embed/package.json embed/package-lock.json embed/tsconfig.json ./embed/
RUN cd embed && npm ci
COPY embed/src ./embed/src
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/frontend/dist /usr/share/nginx/html
EXPOSE 80
