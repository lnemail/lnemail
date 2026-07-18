import { describe, expect, test } from "bun:test";
import {
  ATTENTION_COLOR,
  UNREAD_COLOR,
  computeBadge,
} from "../src/lib/badge.js";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const settings = { renewDaysBefore: 30 };

const active = (email, unreadCount, daysLeft = 200) => ({
  email,
  status: "active",
  unreadCount,
  expiresAt: new Date(NOW + daysLeft * DAY_MS).toISOString(),
});

describe("computeBadge", () => {
  test("empty state shows no badge", () => {
    const badge = computeBadge([], settings, NOW);
    expect(badge.text).toBe("");
    expect(badge.title).toBe("LNemail");
  });

  test("sums unread across active accounts", () => {
    const badge = computeBadge(
      [active("a@x", 2), active("b@x", 3), active("c@x", 0)],
      settings,
      NOW,
    );
    expect(badge.text).toBe("5");
    expect(badge.color).toBe(UNREAD_COLOR);
    expect(badge.title).toContain("5 unread emails");
  });

  test("caps the unread display at 99+", () => {
    const badge = computeBadge([active("a@x", 150)], settings, NOW);
    expect(badge.text).toBe("99+");
  });

  test("uses singular wording for one unread email", () => {
    const badge = computeBadge([active("a@x", 1)], settings, NOW);
    expect(badge.title).toBe("LNemail: 1 unread email");
  });

  test("attention items win over unread counts", () => {
    const pending = { email: "p@x", status: "pending" };
    const badge = computeBadge([pending, active("a@x", 7)], settings, NOW);
    expect(badge.text).toBe("1");
    expect(badge.color).toBe(ATTENTION_COLOR);
    expect(badge.title).toContain("needs attention");
  });

  test("counts expiring accounts as attention items", () => {
    const badge = computeBadge(
      [active("soon@x", 0, 10), active("later@x", 4)],
      settings,
      NOW,
    );
    expect(badge.text).toBe("1");
    expect(badge.color).toBe(ATTENTION_COLOR);
  });

  test("ignores unread counts on non-active accounts", () => {
    const expired = {
      email: "e@x",
      status: "expired",
      unreadCount: 9,
      expiresAt: new Date(NOW - 5 * DAY_MS).toISOString(),
    };
    const badge = computeBadge([expired], settings, NOW);
    // The expired account is an attention item (needs renewal), not an
    // unread source.
    expect(badge.text).toBe("1");
    expect(badge.color).toBe(ATTENTION_COLOR);
  });
});
