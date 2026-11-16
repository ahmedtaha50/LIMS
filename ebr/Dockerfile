# B-Pharma EBR: the application image. Built from the repository; the same build as `npm run build`.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=4100 HOST=0.0.0.0
WORKDIR /app
RUN groupadd --system ebr && useradd --system --gid ebr --home /app ebr
COPY --from=build --chown=ebr:ebr /app/node_modules ./node_modules
COPY --from=build --chown=ebr:ebr /app/dist ./dist
COPY --from=build --chown=ebr:ebr /app/migrations ./migrations
COPY --from=build --chown=ebr:ebr /app/package.json ./package.json
USER ebr
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/main.js"]
