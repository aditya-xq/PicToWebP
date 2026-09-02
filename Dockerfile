FROM node:22-alpine AS web
WORKDIR /web
COPY web-ts/package.json web-ts/package-lock.json ./
RUN npm ci
COPY web-ts/ ./
RUN npm run build:python

FROM python:3.12-slim
WORKDIR /app

COPY pyproject.toml .
COPY src_py/ src_py/
RUN pip install --no-cache-dir ".[web]"

COPY --from=web /web/dist-python/ /app/web-ts/dist-python/

EXPOSE 8000

CMD ["uvicorn", "pictowebp.web.app:app", "--host", "0.0.0.0", "--port", "8000"]