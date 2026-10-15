# Node 22 LTS on Debian (glibc). The claudesynchro engine needs onnxruntime and CTranslate2
# (faster-whisper), which have no wheels for Alpine/musl.
FROM node:22-bookworm-slim AS base

###############
# BUILD STAGE #
###############
FROM base AS builder

# Build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install every Python engine into its own venv
RUN python3 -m venv /opt/venv/ffsubsync && \
    python3 -m venv /opt/venv/autosubsync && \
    python3 -m venv /opt/venv/claudesynchro && \
    /opt/venv/ffsubsync/bin/pip install --no-cache-dir --no-compile ffsubsync "setuptools<70" && \
    /opt/venv/autosubsync/bin/pip install --no-cache-dir --no-compile autosubsync "setuptools<70"

COPY claudesynchro /tmp/claudesynchro
RUN /opt/venv/claudesynchro/bin/pip install --no-cache-dir /tmp/claudesynchro && \
    /opt/venv/claudesynchro/bin/claudesynchro --help > /dev/null

# Set group and user id to 1000 in case node ever decides to change it
ENV PUID=1000
ENV PGID=1000
RUN groupmod -g ${PGID} node && \
    usermod -u ${PUID} -g ${PGID} node && \
    chown -R node:node /home/node

USER node
WORKDIR /app

# Node deps
COPY --chown=node:node package*.json ./
ENV HUSKY=0
RUN npm install --ignore-scripts

# Native rebuild
RUN npm rebuild better-sqlite3

# Build app and cleanup
COPY --chown=node:node . .
RUN npm run build && \
    npm prune --omit=dev --production && \
    npm cache clean --force

####################
# PRODUCTION STAGE #
####################
FROM base AS final

# Runtime deps. ca-certificates: Python (model downloads, OpenRouter) uses the system trust
# store, unlike Node which bundles its own.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Same user as build stage
ENV PUID=1000
ENV PGID=1000
RUN groupmod -g ${PGID} node && \
    usermod -u ${PUID} -g ${PGID} node && \
    chown -R node:node /home/node

# Copy app, python venv installs and bin
COPY --from=builder --chown=node:node /app /app
COPY --from=builder --chown=node:node /opt/venv /opt/venv
COPY --chown=node:node bin/* /home/node/.local/bin/
# Only the claudesynchro command goes on PATH, not its venv (which would shadow python3).
RUN mkdir -p /opt/bin && ln -s /opt/venv/claudesynchro/bin/claudesynchro /opt/bin/claudesynchro

USER node
WORKDIR /app

# Create volume for persistent storage of database (and claudesynchro models, transcripts, reports)
RUN mkdir -p /app/data
VOLUME "/app/data"

# Shown in Diagnostics and debug reports (set by the GitHub workflow)
ARG APP_COMMIT=dev
ARG APP_BUILD_DATE=
ENV APP_COMMIT=${APP_COMMIT} APP_BUILD_DATE=${APP_BUILD_DATE}

# Runtime Env variables
# Listen on all interfaces inside the container; the published port decides who can reach it.
ENV WEB_HOST="0.0.0.0"
ENV CRON_SCHEDULE="0 0 * * *"
ENV NODE_OPTIONS="--max-old-space-size=512"
ENV CLAUDESYNCHRO_DATA_DIR="/app/data/claudesynchro"
ENV HF_HUB_DISABLE_TELEMETRY=1
ENV PATH="/opt/venv/ffsubsync/bin:/opt/venv/autosubsync/bin:/home/node/.local/bin/:/opt/bin:$PATH"

EXPOSE 3000

CMD ["node", "--optimize-for-size", "dist/index-server.js"]
