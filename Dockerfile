# syntax=docker/dockerfile:1
# GI in one image: the Python backend (API, Oracle import, scheduler) also serves the web page
# (plain HTML/CSS/JavaScript, no build step). Build from the repository root:  docker build -t gi .
#
# Base image: any Python 3.10+ image, e.g. the company's approved one:
#   docker build --build-arg PYTHON_IMAGE=registry.example.local/base/python:3.12 -t gi .
ARG PYTHON_IMAGE=python:3.12-slim
FROM ${PYTHON_IMAGE}

# Company networks (all optional): HTTP(S)_PROXY build args, an internal PyPI mirror (PIP_INDEX_URL),
# and a company root certificate (BuildKit secret "company_ca") for TLS-inspecting proxies.
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=3000

WORKDIR /app
# 1. Packages first, so this layer is reused until requirements.txt changes.
COPY requirements.txt ./
RUN --mount=type=secret,id=company_ca \
    if [ -s /run/secrets/company_ca ]; then export PIP_CERT=/run/secrets/company_ca; fi; \
    python -m pip install --index-url "$PIP_INDEX_URL" -r requirements.txt

# 2. The app: backend code, database migrations, and the web page.
COPY backend/gi ./backend/gi
COPY backend/db ./backend/db
COPY frontend ./frontend

# Runs as a non-root user (numeric, so it works on any base image and with runAsNonRoot in Kubernetes).
USER 10001
WORKDIR /app/backend
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/api/health', timeout=4)"
# Migrations run at start-up (under a database lock); with ISSUE_SOURCE=mock the mock Oracle data is generated in memory.
CMD ["python", "-m", "gi.server"]
