# syntax=docker/dockerfile:1
#
# Reliability over image size: this app runs `prisma migrate deploy` (and
# optionally `prisma db seed`, which shells out to `tsx`) at container boot,
# so the runtime image keeps the full node_modules rather than a trimmed
# `output: standalone` trace, which would drop that CLI tooling.

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/app/generated ./app/generated
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma7.config.ts ./prisma7.config.ts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["./entrypoint.sh"]
CMD ["npm", "start"]
