FROM node:22.12.0-alpine AS build
WORKDIR /workspace
RUN npm install -g npm@11.7.0
COPY package.json package-lock.json ./
COPY apps/auth/package.json apps/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY apps/auth apps/auth
COPY packages/config packages/config
COPY packages/observability packages/observability
RUN npm run build --workspace=@huddle/config && npm run build --workspace=@huddle/observability && npm run build --workspace=@huddle/auth

FROM node:22.12.0-alpine
WORKDIR /workspace
ENV NODE_ENV=production
RUN npm install -g npm@11.7.0
COPY package.json package-lock.json ./
COPY apps/auth/package.json apps/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /workspace/apps/auth/dist apps/auth/dist
COPY --from=build /workspace/packages/config/dist packages/config/dist
COPY --from=build /workspace/packages/observability/dist packages/observability/dist
USER node
CMD ["node", "apps/auth/dist/index.js"]
