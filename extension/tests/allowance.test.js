import { describe, expect, test } from "bun:test";
import {
  canAutoPay,
  monthlySpent,
  recordSpend,
} from "../src/lib/allowance.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-18T12:00:00Z");

const settings = {
  autoPayEnabled: true,
  nwcUri: "nostr+walletconnect://abc?relay=wss://r&secret=def",
};

describe("monthlySpent", () => {
  test("sums only the rolling 30-day window", () => {
    const history = [
      { at: NOW - 31 * DAY_MS, sats: 500 },
      { at: NOW - 29 * DAY_MS, sats: 300 },
      { at: NOW - DAY_MS, sats: 200 },
    ];
    expect(monthlySpent(history, NOW)).toBe(500);
  });

  test("handles empty and missing history", () => {
    expect(monthlySpent([], NOW)).toBe(0);
    expect(monthlySpent(undefined, NOW)).toBe(0);
  });
});

describe("canAutoPay", () => {
  test("allows a payment matching the quoted price", () => {
    const result = canAutoPay(settings, 1000, 1000);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });

  test("allows without a quote (no price to compare against)", () => {
    expect(canAutoPay(settings, 500).allowed).toBe(true);
  });

  test("denies when auto-pay is disabled", () => {
    const result = canAutoPay({ ...settings, autoPayEnabled: false }, 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("disabled");
  });

  test("denies without an NWC wallet", () => {
    const result = canAutoPay({ ...settings, nwcUri: "" }, 10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("NWC");
  });

  test("denies invoices above the quoted price", () => {
    const result = canAutoPay(settings, 1001, 1000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("quoted price");
  });

  test("allows invoices below the quoted price", () => {
    expect(canAutoPay(settings, 999, 1000).allowed).toBe(true);
  });

  test("denies any-amount invoices", () => {
    const result = canAutoPay(settings, null);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("no fixed amount");
  });

  test("denies invalid amounts", () => {
    expect(canAutoPay(settings, 0).allowed).toBe(false);
    expect(canAutoPay(settings, -5).allowed).toBe(false);
    expect(canAutoPay(settings, Number.NaN).allowed).toBe(false);
  });
});

describe("recordSpend", () => {
  test("appends and prunes entries older than 60 days", () => {
    const history = [
      { at: NOW - 61 * DAY_MS, sats: 100, kind: "signup" },
      { at: NOW - 10 * DAY_MS, sats: 200, kind: "renewal" },
    ];
    const updated = recordSpend(history, { at: NOW, sats: 300, kind: "signup" });
    expect(updated).toHaveLength(2);
    expect(updated[0].sats).toBe(200);
    expect(updated[1].sats).toBe(300);
  });
});
