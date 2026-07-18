import { describe, expect, test } from "bun:test";
import { invoiceAmount, invoiceAmountSats } from "../src/lib/bolt11.js";

describe("invoiceAmountSats", () => {
  test("parses micro-BTC amounts", () => {
    // 10u = 10 * 100_000_000 / 1_000_000 = 1000 sats
    expect(invoiceAmountSats("lnbc10u1pjluevupp5xyz")).toBe(1000);
  });

  test("parses milli-BTC amounts", () => {
    // 1m = 100_000 sats
    expect(invoiceAmountSats("lnbc1m1pjluevupp5xyz")).toBe(100000);
  });

  test("parses nano-BTC amounts", () => {
    // 100n = 10 sats
    expect(invoiceAmountSats("lnbc100n1pjluevupp5xyz")).toBe(10);
  });

  test("parses pico-BTC amounts with msat precision", () => {
    // 10p = 1 msat
    expect(invoiceAmount("lnbc10p1pjluevupp5xyz").msats).toBe(1);
  });

  test("parses whole-BTC amounts", () => {
    expect(invoiceAmountSats("lnbc11pjluevupp5xyz")).toBe(100000000);
  });

  test("is case-insensitive", () => {
    expect(invoiceAmountSats("LNBC10U1PJLUEVUPP5XYZ")).toBe(1000);
  });

  test("supports testnet and regtest prefixes", () => {
    expect(invoiceAmountSats("lntb10u1pjluevupp5xyz")).toBe(1000);
    expect(invoiceAmountSats("lnbcrt10u1pjluevupp5xyz")).toBe(1000);
  });

  test("returns null for any-amount invoices", () => {
    expect(invoiceAmountSats("lnbc1pjluevupp5xyz")).toBeNull();
  });

  test("rejects sub-millisatoshi amounts", () => {
    expect(() => invoiceAmountSats("lnbc1p1pjluevupp5xyz")).toThrow(
      "sub-millisatoshi",
    );
  });

  test("rejects non-invoice strings", () => {
    expect(() => invoiceAmountSats("hello")).toThrow("Not a BOLT11");
    expect(() => invoiceAmountSats("")).toThrow("Not a BOLT11");
  });

  test("rejects non-string input", () => {
    expect(() => invoiceAmountSats(null)).toThrow("Invalid payment request");
  });
});
