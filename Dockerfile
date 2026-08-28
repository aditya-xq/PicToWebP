FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

COPY src/ src/

EXPOSE 8000

CMD ["uvicorn", "pictowebp.web.app:app", "--host", "0.0.0.0", "--port", "8000"]
