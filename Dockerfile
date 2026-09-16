FROM node:22-slim AS build
RUN apt-get update && apt-get -y install python3 build-essential
WORKDIR /app
COPY . .
RUN npm install

FROM node:22-slim
RUN mkdir /data
VOLUME /data
COPY --from=build /app /app

ENTRYPOINT [ "/usr/local/bin/node", "/app/cli.js"]
