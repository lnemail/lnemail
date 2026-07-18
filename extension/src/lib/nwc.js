/**
 * Minimal Nostr Wallet Connect (NIP-47) client.
 *
 * Speaks raw relay WebSocket messages and uses nostr-tools for event
 * signing and NIP-04 encryption. Only the request/response flow needed
 * by the extension (pay_invoice, get_balance, get_info) is implemented.
 */

import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import * as nip04 from "nostr-tools/nip04";

export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Convert a hex string to bytes.
 *
 * @param {string} hex Hex-encoded string.
 * @returns {Uint8Array} Decoded bytes.
 */
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error("Invalid hex string");
    }
    bytes[i] = byte;
  }
  return bytes;
}

/**
 * Parse a `nostr+walletconnect://` connection URI.
 *
 * @param {string} uri NWC connection string.
 * @returns {{walletPubkey: string, relays: string[], secret: string,
 *            lud16: string | null}}
 * @throws {Error} If the URI is malformed or missing required parts.
 */
export function parseNwcUri(uri) {
  if (typeof uri !== "string") {
    throw new Error("Invalid NWC URI");
  }
  const trimmed = uri.trim().replace(/^["']|["']$/g, "");
  const match = /^nostr\+walletconnect:\/\/([0-9a-f]{64})\?(.*)$/i.exec(trimmed);
  if (!match) {
    throw new Error("Invalid NWC URI (expected nostr+walletconnect://<pubkey>?...)");
  }
  const walletPubkey = match[1].toLowerCase();
  const params = new URLSearchParams(match[2]);
  const relays = params.getAll("relay").filter(Boolean);
  const secret = (params.get("secret") ?? "").toLowerCase();
  if (relays.length === 0) {
    throw new Error("NWC URI is missing a relay");
  }
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error("NWC URI is missing a valid secret");
  }
  return { walletPubkey, relays, secret, lud16: params.get("lud16") };
}

/**
 * Build a signed, encrypted NIP-47 request event.
 *
 * @param {{walletPubkey: string, secret: string}} connection Parsed URI.
 * @param {string} method NIP-47 method name (for example "pay_invoice").
 * @param {object} params Method parameters.
 * @returns {import("nostr-tools").VerifiedEvent} Signed request event.
 */
export function buildRequestEvent(connection, method, params) {
  const secretBytes = hexToBytes(connection.secret);
  const content = nip04.encrypt(
    connection.secret,
    connection.walletPubkey,
    JSON.stringify({ method, params }),
  );
  return finalizeEvent(
    {
      kind: NWC_REQUEST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", connection.walletPubkey]],
      content,
    },
    secretBytes,
  );
}

/**
 * Decrypt and validate a NIP-47 response event.
 *
 * @param {{walletPubkey: string, secret: string}} connection Parsed URI.
 * @param {object} event Response event (kind 23195).
 * @returns {{result_type: string, error: object | null, result: object | null}}
 * @throws {Error} If the event is not a valid response from the wallet.
 */
export function decryptResponseEvent(connection, event) {
  if (event.kind !== NWC_RESPONSE_KIND) {
    throw new Error("Unexpected event kind");
  }
  if (event.pubkey !== connection.walletPubkey) {
    throw new Error("Response from unexpected pubkey");
  }
  if (!verifyEvent(event)) {
    throw new Error("Invalid event signature");
  }
  const plaintext = nip04.decrypt(
    connection.secret,
    connection.walletPubkey,
    event.content,
  );
  return JSON.parse(plaintext);
}

/**
 * Perform a NIP-47 request against a single relay.
 *
 * @param {string} relayUrl Relay WebSocket URL.
 * @param {{walletPubkey: string, secret: string}} connection Parsed URI.
 * @param {object} requestEvent Signed request event.
 * @param {number} timeoutMs Overall timeout.
 * @returns {Promise<object>} Decrypted NIP-47 response payload.
 */
function requestViaRelay(relayUrl, connection, requestEvent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const subId = `lnemail-${Math.random().toString(36).slice(2, 10)}`;
    let settled = false;
    let ws;
    const timer = setTimeout(() => {
      fail(new Error(`NWC request timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          // Ignore close errors.
        }
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    try {
      ws = new WebSocket(relayUrl);
    } catch (error) {
      fail(error);
      return;
    }
    ws.onerror = () => fail(new Error(`Relay connection failed: ${relayUrl}`));
    ws.onclose = () => fail(new Error(`Relay connection closed: ${relayUrl}`));
    ws.onopen = () => {
      ws.send(
        JSON.stringify([
          "REQ",
          subId,
          {
            kinds: [NWC_RESPONSE_KIND],
            authors: [connection.walletPubkey],
            "#e": [requestEvent.id],
          },
        ]),
      );
      ws.send(JSON.stringify(["EVENT", requestEvent]));
    };
    ws.onmessage = (message) => {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      const [type, ...rest] = data;
      if (type === "OK" && rest[0] === requestEvent.id && rest[1] === false) {
        fail(new Error(`Relay rejected request: ${rest[2] ?? "unknown reason"}`));
      } else if (type === "EVENT" && rest[0] === subId) {
        try {
          succeed(decryptResponseEvent(connection, rest[1]));
        } catch (error) {
          fail(error);
        }
      } else if (type === "CLOSED" && rest[0] === subId) {
        fail(new Error(`Relay closed subscription: ${rest[1] ?? ""}`));
      }
    };
  });
}

/**
 * Send a NIP-47 request, trying each relay in the URI until one works.
 *
 * @param {string} uri NWC connection string.
 * @param {string} method NIP-47 method name.
 * @param {object} params Method parameters.
 * @param {{timeoutMs?: number}} [options] Request options.
 * @returns {Promise<object>} The NIP-47 `result` payload.
 * @throws {Error} If every relay fails or the wallet returns an error.
 */
export async function nwcCall(uri, method, params, options = {}) {
  const connection = parseNwcUri(uri);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestEvent = buildRequestEvent(connection, method, params);
  let lastError = new Error("No relays available");
  for (const relayUrl of connection.relays) {
    try {
      const response = await requestViaRelay(
        relayUrl,
        connection,
        requestEvent,
        timeoutMs,
      );
      if (response.error) {
        throw new Error(
          `Wallet error (${response.error.code ?? "UNKNOWN"}): ` +
            `${response.error.message ?? "no message"}`,
        );
      }
      return response.result ?? {};
    } catch (error) {
      lastError = error;
      // A definitive wallet-side error should not be retried on the
      // next relay: the wallet already saw and rejected the request.
      if (String(error.message).startsWith("Wallet error")) {
        throw error;
      }
    }
  }
  throw lastError;
}

/**
 * Pay a BOLT11 invoice through the connected wallet.
 *
 * @param {string} uri NWC connection string.
 * @param {string} invoice BOLT11 payment request.
 * @param {{timeoutMs?: number}} [options] Request options.
 * @returns {Promise<{preimage: string}>} Payment result with preimage.
 */
export function payInvoice(uri, invoice, options) {
  return nwcCall(uri, "pay_invoice", { invoice }, options);
}

/**
 * Query wallet balance (msats) for the settings "test connection" action.
 *
 * @param {string} uri NWC connection string.
 * @param {{timeoutMs?: number}} [options] Request options.
 * @returns {Promise<{balance: number}>} Balance result in msats.
 */
export function getBalance(uri, options) {
  return nwcCall(uri, "get_balance", {}, options);
}

/**
 * Derive the client public key for a connection (useful for debugging).
 *
 * @param {string} uri NWC connection string.
 * @returns {string} Hex public key of the client secret.
 */
export function clientPubkey(uri) {
  const { secret } = parseNwcUri(uri);
  return getPublicKey(hexToBytes(secret));
}
