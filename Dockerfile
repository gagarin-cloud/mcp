# Container image for the gagarin MCP server.
#
# The build context is this repository. It carries no other gagarin source: the
# server is a translation of the HTTP API, not a second implementation of it, so
# it shares nothing with the engine but a contract.

FROM node:22-alpine AS build
WORKDIR /src

# Dependencies first, from the lockfile only. `npm ci` refuses to reconcile a
# package.json that disagrees with package-lock.json, which is the property that
# makes a CI build reproducible — `npm install` would quietly resolve a newer
# version and ship something nobody tested.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# Built and then tested, and the tests removed from what ships. They are worth
# running here rather than only in CI — this is the one place the image and the
# code it was built from are provably the same thing.
RUN npm run build && node --test dist/*.test.js && rm -f dist/*.test.js dist/*.test.d.ts dist/*.test.js.map

# The runtime tree, without the compiler or the tests. `npm ci --omit=dev` in a
# separate stage rather than `npm prune`, so the layer is built from the lockfile
# rather than from whatever pruning left behind.
FROM node:22-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The `node` user, by number rather than by name.
#
# Both work for `docker run`, and only one works under Kubernetes: the pod spec
# behind mcp.gagarin.cloud sets runAsNonRoot, and a kubelet cannot verify that
# from a *name* — it refuses the container with "image has non-numeric user
# (node), cannot verify user is non-root" and the Deployment never starts.
# 1000:1000 is what `node` is in this image.
#
# Nothing here writes to disk, so there is nothing for it to own; the pod also
# runs with a read-only root filesystem and an emptyDir at /tmp.
USER 1000:1000
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json ./
EXPOSE 8080
# node directly, not `npm start`: npm adds a process that forwards no signals,
# so SIGTERM from a rolling deploy would kill the pod at the socket instead of
# reaching the drain in http.ts.
CMD ["node", "dist/http.js"]
