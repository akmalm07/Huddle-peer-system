FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build --workspace=@huddle/signaling

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/signaling ./apps/signaling
COPY --from=build /app/packages/config ./packages/config
COPY --from=build /app/packages/observability ./packages/observability
EXPOSE 4002
CMD ["node", "apps/signaling/dist/index.js"]
