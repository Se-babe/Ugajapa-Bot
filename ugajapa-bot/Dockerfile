FROM python:3.11-slim

WORKDIR /app

# sentencepiece/protobuf wheels; keep image small (no build-essential unless needed)
COPY requirements.txt .

# CPU-only PyTorch (~200MB) � official pytorch/pytorch has no slim CPU tags
RUN pip install --no-cache-dir --default-timeout=600 \
    --index-url https://download.pytorch.org/whl/cpu \
    torch==2.5.1 \
 && pip install --no-cache-dir --default-timeout=600 -r requirements.txt

COPY server.py .

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
