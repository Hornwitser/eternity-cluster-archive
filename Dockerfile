FROM node:21-alpine

# Use production node environment by default.
ENV NODE_ENV production
ENV ROOT_DIR /public
ENV PUBLIC_URL http://localhost:8000

# Archive data is read from /public
VOLUME ["/public"]

# Install everything into /app
WORKDIR /app

# Download dependencies as a separate step to take advantage of Docker's caching.
# Leverage a cache mount to /root/.npm to speed up subsequent builds.
# Leverage a bind mounts to package.json and package-lock.json to avoid having to copy them into
# into this layer.
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Run the application as non-root
USER node

# Copy source files into /app
COPY . .

EXPOSE 8000
CMD ["node", "index.js"]
