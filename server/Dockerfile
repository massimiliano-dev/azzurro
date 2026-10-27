FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --workspace server --include-workspace-root=false --omit=dev
COPY server server
ENV NODE_ENV=production PORT=4000
EXPOSE 4000 4443
CMD ["node", "--experimental-strip-types", "server/src/index.ts"]
