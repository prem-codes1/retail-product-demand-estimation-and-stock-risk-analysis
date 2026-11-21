FROM python:3.11-slim

WORKDIR /app

# Install system dependencies if required
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency definition and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application and data files
COPY main.py .
COPY cloud_runner.py .
COPY data/ ./data/

# Expose standard port
EXPOSE 8000

# Start Cloud Runner (FastAPI + ngrok static domain)
CMD ["python", "cloud_runner.py"]
