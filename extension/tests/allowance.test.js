import { describe, expect, test } from "bun:test";
import {
  evaluateSpend,
  monthlySpent,
  recordSpend,
} from "../src/lib/allowance.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-18T12:00:00Z");

const settings = {
  autoPayEnabled: true,
  nwcUri: "nostr+walletconnect://abc?relay=wss://r&secret=def",
  maxSatsPerPayment: 1000,
  monthlyBudgetSats: 2500,
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

describe("evaluateSpend", () => {
  test("allows a payment within limits", () => {
    const result = evaluateSpend(settings, [], 500, NOW);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });

  test("denies when auto-pay is disabled", () => {
    const result = evaluateSpend({ ...settings, autoPayEnabled: false }, [], 10, NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("disabled");
  });

  test("denies without an NWC wallet", () => {
    const result = evaluateSpend({ ...settings, nwcUri: "" }, [], 10, NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("NWC");
  });

  test("denies amounts above the per-payment limit", () => {
    const result = evaluateSpend(settings, [], 1001, NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("per-payment limit");
  });

  test("denies when the monthly budget would be exceeded", () => {
    const history = [{ at: NOW - DAY_MS, sats: 2000 }];
    const result = evaluateSpend(settings, history, 600, NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("30-day budget");
  });

  test("allows once old spends age out of the window", () => {
    const history = [{ at: NOW - 31 * DAY_MS, sats: 2400 }];
    const result = evaluateSpend(settings, history, 600, NOW);
    expect(result.allowed).toBe(true);
  });

  test("denies any-amount invoices", () => {
    const result = evaluateSpend(settings, [], null, NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("no fixed amount");
  });

  test("denies invalid amounts and zero limits", () => {
    expect(evaluateSpend(settings, [], 0, NOW).allowed).toBe(false);
    expect(evaluateSpend(settings, [], -5, NOW).allowed).toBe(false);
    expect(
      evaluateSpend({ ...settings, maxSatsPerPayment: 0 }, [], 1, NOW).allowed,
    ).toBe(false);
    expect(
      evaluateSpend({ ...settings, monthlyBudgetSats: 0 }, [], 1, NOW).allowed,
    ).toBe(false);
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
