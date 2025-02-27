FROM node:22-alpine AS builder

# Must be entire project because `prepare` script is run during `npm install` and requires all files.
COPY . /app
COPY tsconfig.json /tsconfig.json

WORKDIR /app

RUN --mount=type=cache,target=/root/.npm npm i

FROM node:22-alpine AS release

WORKDIR /app

COPY --from=builder /app/build /app/build
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json

ENV NODE_ENV=production

RUN npm i --frozen-lockfile --ignore-scripts

ENTRYPOINT ["node", "build/index.js"]
