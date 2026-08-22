# Tickety API — container image for Cloud Run.
#
# No credentials are baked in. The service picks up Application Default
# Credentials from the Cloud Run runtime service account, which is why the
# `firebase-admin.json` key file this project used to carry is both unnecessary
# and, in an image, actively dangerous: an image layer is readable by anyone
# who can pull it.

# ---- dependencies -----------------------------------------------------------
FROM node:20-slim AS deps

WORKDIR /app

# Copied on their own so this layer is cached until the lockfile actually
# changes, rather than on every source edit.
COPY package.json package-lock.json ./

# `npm ci` installs exactly the lockfile, and omitting dev dependencies keeps
# nodemon and friends out of the runtime image.
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ----------------------------------------------------------------
FROM node:20-slim AS runtime

ENV NODE_ENV=production

# The base image ships an unprivileged `node` user. Running as root would mean a
# process escape lands with root inside the container.
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node

# Cloud Run injects PORT and expects the container to bind it on 0.0.0.0.
# This is documentation for local runs; the value is not authoritative.
ENV PORT=8080
EXPOSE 8080

# Node runs as PID 1 here. `index.js` installs SIGTERM handling so in-flight
# requests drain during a Cloud Run revision swap rather than being cut off.
CMD ["node", "src/index.js"]
