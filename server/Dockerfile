FROM python:3.11-slim

LABEL org.opencontainers.image.title="NMS-Tool"
LABEL org.opencontainers.image.description="Network Management System"

# System deps for SNMP and net tools
RUN apt-get update && apt-get install -y \
    libsnmp-dev \
    snmp \
    iputils-ping \
    net-tools \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY core/ ./core/
COPY api/ ./api/
COPY frontend/dist/ ./frontend/dist/
COPY .env.example .env.example

# Create data directories
RUN mkdir -p data/mibs data/logs

# Non-root user (note: SNMP port 162 still requires cap_add NET_BIND_SERVICE)
RUN useradd -m -u 1000 nms && chown -R nms:nms /app
USER nms

EXPOSE 8765
EXPOSE 162/udp

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8765/api/v1/ping')" || exit 1

CMD ["python", "-m", "uvicorn", "api.main:app", \
     "--host", "0.0.0.0", "--port", "8765", \
     "--workers", "2", "--log-level", "warning"]
