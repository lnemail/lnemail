import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import * as nip04 from "nostr-tools/nip04";
import {
  buildRequestEvent,
  decryptResponseEvent,
  parseNwcUri,
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
} from "../src/lib/nwc.js";

/**
 * @param {Uint8Array} bytes Bytes to encode.
 * @returns {string} Hex string.
 */
function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const WALLET_SECRET = generateSecretKey();
const WALLET_PUBKEY = getPublicKey(WALLET_SECRET);
const CLIENT_SECRET_HEX = bytesToHex(generateSecretKey());

const URI =
  `nostr+walletconnect://${WALLET_PUBKEY}` +
  `?relay=wss://relay.example.com&relay=wss://backup.example.com` +
  `&secret=${CLIENT_SECRET_HEX}&lud16=user@example.com`;

describe("parseNwcUri", () => {
  test("parses a full URI", () => {
    const parsed = parseNwcUri(URI);
    expect(parsed.walletPubkey).toBe(WALLET_PUBKEY);
    expect(parsed.relays).toEqual([
      "wss://relay.example.com",
      "wss://backup.example.com",
    ]);
    expect(parsed.secret).toBe(CLIENT_SECRET_HEX);
    expect(parsed.lud16).toBe("user@example.com");
  });

  test("strips surrounding quotes (docker-compose copy-paste)", () => {
    expect(parseNwcUri(`"${URI}"`).walletPubkey).toBe(WALLET_PUBKEY);
  });

  test("rejects missing relay", () => {
    expect(() =>
      parseNwcUri(
        `nostr+walletconnect://${WALLET_PUBKEY}?secret=${CLIENT_SECRET_HEX}`,
      ),
    ).toThrow("missing a relay");
  });

  test("rejects missing or invalid secret", () => {
    expect(() =>
      parseNwcUri(`nostr+walletconnect://${WALLET_PUBKEY}?relay=wss://r`),
    ).toThrow("secret");
    expect(() =>
      parseNwcUri(
        `nostr+walletconnect://${WALLET_PUBKEY}?relay=wss://r&secret=nothex`,
      ),
    ).toThrow("secret");
  });

  test("rejects malformed URIs", () => {
    expect(() => parseNwcUri("https://example.com")).toThrow("Invalid NWC URI");
    expect(() => parseNwcUri(null)).toThrow("Invalid NWC URI");
  });
});

describe("buildRequestEvent / decryptResponseEvent", () => {
  test("round-trips a pay_invoice request", () => {
    const connection = parseNwcUri(URI);
    const event = buildRequestEvent(connection, "pay_invoice", {
      invoice: "lnbc10u1fake",
    });

    expect(event.kind).toBe(NWC_REQUEST_KIND);
    expect(event.tags).toEqual([["p", WALLET_PUBKEY]]);

    // The wallet decrypts the request with its own secret.
    const plaintext = nip04.decrypt(
      bytesToHex(WALLET_SECRET),
      event.pubkey,
      event.content,
    );
    expect(JSON.parse(plaintext)).toEqual({
      method: "pay_invoice",
      params: { invoice: "lnbc10u1fake" },
    });

    // The wallet answers with an encrypted response event.
    const responsePayload = {
      result_type: "pay_invoice",
      error: null,
      result: { preimage: "00".repeat(32) },
    };
    const responseEvent = finalizeEvent(
      {
        kind: NWC_RESPONSE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["p", event.pubkey],
          ["e", event.id],
        ],
        content: nip04.encrypt(
          bytesToHex(WALLET_SECRET),
          event.pubkey,
          JSON.stringify(responsePayload),
        ),
      },
      WALLET_SECRET,
    );

    const decrypted = decryptResponseEvent(connection, responseEvent);
    expect(decrypted).toEqual(responsePayload);
  });

  test("rejects responses from an unexpected pubkey", () => {
    const connection = parseNwcUri(URI);
    const otherSecret = generateSecretKey();
    const forged = finalizeEvent(
      {
        kind: NWC_RESPONSE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: "junk?iv=junk",
      },
      otherSecret,
    );
    expect(() => decryptResponseEvent(connection, forged)).toThrow(
      "unexpected pubkey",
    );
  });

  test("rejects wrong event kinds", () => {
    const connection = parseNwcUri(URI);
    expect(() =>
      decryptResponseEvent(connection, { kind: 1, pubkey: WALLET_PUBKEY }),
    ).toThrow("Unexpected event kind");
  });
});
