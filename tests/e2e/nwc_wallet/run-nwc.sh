#!/usr/bin/env bash
# Run the e2e suite against the NWC payment backend.
#
# This boots the normal dev stack, waits for the LN channel, then layers
# the NWC override (a Nostr relay + a NIP-47 wallet service backed by the
# regtest merchant LND) and reconfigures lnemail to use NWC exclusively
# (NWC_ONLY). The SAME Playwright suite then validates signup, send and
# renewal -- this time every invoice is created and looked up over NWC.
#
#   ./tests/e2e/nwc_wallet/run-nwc.sh
#
# Notes:
#   * The merchant LND must have an active channel to the router before
#     payments work; this script waits for it.
#   * Throwaway regtest keys are baked into docker-compose.e2e-nwc.yaml.
set -euo pipefail

cd "$(dirname "$0")/../../.."

ENV_FILE=".env.development"
BASE="docker-compose.yaml"
OVERRIDE="tests/e2e/nwc_wallet/docker-compose.e2e-nwc.yaml"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$BASE" -f "$OVERRIDE" "$@"
}

echo "==> Booting base stack"
bash scripts/setup.sh >/dev/null 2>&1 || true
docker compose --env-file "$ENV_FILE" up -d

echo "==> Waiting for an active LND <-> router channel"
for i in $(seq 1 60); do
  count=$(docker exec lnd lncli --network=regtest listchannels 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(1 for c in d.get('channels',[]) if c.get('active')))" \
    2>/dev/null || echo 0)
  if [ "${count:-0}" -ge 1 ]; then
    echo "    channel active"
    break
  fi
  sleep 10
done

echo "==> Building + starting NWC relay and wallet, switching lnemail to NWC"
compose build lnemail-api lnemail-worker nwc-wallet
compose up -d --force-recreate relay nwc-wallet lnemail-api lnemail-worker

echo "==> Waiting for the NWC wallet to publish its URI and the API to be healthy"
for i in $(seq 1 30); do
  if curl -fsS http://localhost:8000/api/health >/dev/null 2>&1; then
    if docker logs lnemail-api 2>&1 | grep -q "Payment backend: multi-provider"; then
      echo "    API up on the NWC backend"
      break
    fi
  fi
  sleep 5
done

echo "==> Running the Playwright suite against the NWC backend"
python -m pytest tests/e2e -v "$@"
