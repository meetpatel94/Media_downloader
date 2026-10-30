# Production image for the media downloader.
#
# FFmpeg is installed explicitly because MP3 conversion requires it. Everything
# else (URL validation, MP4 delivery) works without FFmpeg.
FROM node:22-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# Optional dependencies are skipped: Debian's FFmpeg above is used instead of
# the bundled installer binary.
RUN npm ci --omit=optional

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts

USER nextjs
EXPOSE 3000

# Downloads and conversions are bounded by the MEDIA_DOWNLOADER_* limits.
CMD ["npm", "start"]
