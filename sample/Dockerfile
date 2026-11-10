# Stage 1: Build frontend
FROM node:22-alpine AS frontend
WORKDIR /app
COPY client/package*.json ./
RUN npm ci
COPY client/ .
RUN npm run build

# Stage 2: Compile TypeScript
FROM node:22-alpine AS backend
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npx tsc

# Stage 3: Runtime
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=backend --chown=node:node /app/dist dist/
# dist/api/index.js resolves __dirname/../public → dist/public
COPY --from=frontend --chown=node:node /app/dist dist/public/
USER node
CMD ["node", "dist/index.js"]
