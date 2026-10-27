FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --workspace web --include-workspace-root=false
COPY web web
ARG AZZURRO_API_URL=http://api:4000
ENV AZZURRO_API_URL=$AZZURRO_API_URL
RUN npm run build -w web

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./web/.next/static
COPY --from=build /app/web/public ./web/public
EXPOSE 3000
CMD ["node", "web/server.js"]
