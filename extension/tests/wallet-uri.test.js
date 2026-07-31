import { describe, expect, test } from "bun:test";
import { isAndroidUserAgent, walletUri } from "../src/lib/wallet-uri.js";

const INVOICE = "lnbc10u1pjluevupp5xyz";

describe("walletUri", () => {
  test("builds a desktop BIP 321 URI", () => {
    expect(walletUri(INVOICE)).toBe(`bitcoin:?lightning=${INVOICE}`);
  });

  test("builds an Android intent that resolves the BIP 321 URI", () => {
    expect(walletUri(INVOICE, { android: true })).toBe(
      `intent:?lightning=${INVOICE}#Intent;scheme=bitcoin;end`,
    );
  });

  test("accepts supported networks and consistently-cased invoices", () => {
    expect(walletUri(INVOICE.toUpperCase())).toBe(
      `bitcoin:?lightning=${INVOICE.toUpperCase()}`,
    );
    expect(walletUri("lntb10u1pjluevupp5xyz")).toBe(
      "bitcoin:?lightning=lntb10u1pjluevupp5xyz",
    );
    expect(walletUri("lnbcrt10u1pjluevupp5xyz")).toBe(
      "bitcoin:?lightning=lnbcrt10u1pjluevupp5xyz",
    );
  });

  test("rejects values that could inject intent directives", () => {
    expect(() => walletUri(`${INVOICE};package=attacker`)).toThrow(
      "Invalid BOLT11 invoice",
    );
    expect(() => walletUri("")).toThrow("Invalid BOLT11 invoice");
    expect(() => walletUri(null)).toThrow("Invalid BOLT11 invoice");
    expect(() => walletUri("lnfoo10u1pjluevupp5xyz")).toThrow(
      "Invalid BOLT11 invoice",
    );
    expect(() => walletUri("lnbc10u1PJLUEVUPP5XYZ")).toThrow(
      "Invalid BOLT11 invoice",
    );
    expect(() => walletUri("lnbc01u1pjluevupp5xyz")).toThrow(
      "Invalid BOLT11 invoice",
    );
    expect(() => walletUri("lnbc1p1pjluevupp5xyz")).toThrow(
      "Invalid BOLT11 invoice",
    );
  });
});

describe("isAndroidUserAgent", () => {
  test("detects Firefox Android", () => {
    expect(
      isAndroidUserAgent(
        "Mozilla/5.0 (Android 15; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0",
      ),
    ).toBe(true);
  });

  test("detects Chrome Android", () => {
    expect(
      isAndroidUserAgent(
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(true);
  });

  test("does not classify desktop Firefox as Android", () => {
    expect(
      isAndroidUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0",
      ),
    ).toBe(false);
  });
});
