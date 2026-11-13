FROM node:22-alpine AS web
WORKDIR /web
COPY web-ts/package.json web-ts/package-lock.json ./
RUN npm ci
COPY web-ts/ ./
# The build publishes the agent surface (llms.txt, .well-known manifests) from
# repository files, so the repo root has to exist at `/` , the parent of
# WORKDIR. Keep these in sync with REQUIRED_SOURCES in
# web-ts/build/agent-surfaces.ts.
COPY agent/ /agent/
COPY docs/agent-contract.md /docs/agent-contract.md
COPY llms.txt /llms.txt
RUN npm run build:python

FROM python:3.12-slim
WORKDIR /app

COPY pyproject.toml .
COPY src_py/ src_py/
RUN pip install --no-cache-dir ".[web]"

COPY --from=web /web/dist-python/ /app/web-ts/dist-python/

EXPOSE 8000

CMD ["uvicorn", "pictowebp.web.app:app", "--host", "0.0.0.0", "--port", "8000"]