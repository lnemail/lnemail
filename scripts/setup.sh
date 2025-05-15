#!/bin/bash

# Create necessary directories
mkdir -p dev-data/mail-data
mkdir -p dev-data/mail-state
mkdir -p dev-data/mail-logs
mkdir -p dev-data/config
mkdir -p dev-data/mail-agent
mkdir -p dev-data/shared/requests
mkdir -p dev-data/shared/responses
mkdir -p dev-data/lnemail-data
mkdir -p dev-data/redis-data
mkdir -p docker/lnd

# Set permissions
chmod -R 777 dev-data

# Create docker/lnd directory if it doesn't exist
mkdir -p docker/lnd

echo "Setup complete. You can now start the development environment with:"
echo "docker-compose up -d"
