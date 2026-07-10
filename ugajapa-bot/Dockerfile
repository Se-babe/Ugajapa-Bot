FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# CPU-only torch (~200MB) � avoids the 900MB+ CUDA wheel timeout on slow links.
# Increase timeout for large Hugging Face / PyPI downloads.
RUN pip install --no-cache-dir --default-timeout=1000 \
    --index-url https://download.pytorch.org/whl/cpu \
    torch==2.5.1 \
 && pip install --no-cache-dir --default-timeout=1000 -r requirements.txt

COPY server.py nllb_langs.py .

EXPOSE 8000

# Pre-download can still happen on first /health after start; keep CMD simple.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
