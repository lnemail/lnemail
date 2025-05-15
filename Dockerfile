FROM python:3.11-slim as base

# Set environment variables
ENV PYTHONFAULTHANDLER=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    POETRY_NO_INTERACTION=1 \
    POETRY_VIRTUALENVS_CREATE=0

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    gcc \
    libc6-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Poetry
RUN pip install poetry==1.6.1

# Copy only dependency files first
COPY pyproject.toml poetry.lock* /app/

# Install dependencies only (not the application code)
RUN poetry install --no-root

# Create necessary directories
RUN mkdir -p /data/lnemail/mail-data

# Create a non-root user and change ownership of directories
RUN useradd -m -d /app appuser \
    && chown -R appuser:appuser /app /data

# Switch to non-root user
USER appuser

#######################
# Development stage
#######################
FROM base as development

# Install development dependencies
USER root
RUN poetry install --no-root --with dev
USER appuser

# Copy application code (this will be overridden by volume mount in dev)
COPY --chown=appuser:appuser . /app/

# Install the application itself
RUN poetry install --only-root

# Command for development with hot reloading
CMD ["uvicorn", "src.lnemail.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload", "--proxy-headers"]

#######################
# Production stage
#######################
FROM base as production

# Copy application code AFTER installing dependencies
# This is the key optimization - code changes won't invalidate dependency layers
COPY --chown=appuser:appuser . /app/

# Install the application itself (after dependencies are installed)
RUN poetry install --only-root

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import requests; requests.get('http://localhost:8000/api/health').raise_for_status()" || exit 1

# Command to run the application
CMD ["uvicorn", "src.lnemail.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
