import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_STATUS,
  DEFAULT_SETTINGS,
  accountFromInvoice,
  accountsForDomain,
  accountsNeedingRenewal,
  findByPaymentHash,
  findByRenewalHash,
  latestUnread,
  loadState,
  recordUsage,
  upsertAccount,
} from "../src/lib/store.js";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const invoice = {
  email_address: "calmriver123@lnemail.net",
  access_token: "lne_AAAAA-BBBBB-CCCCC-DDDDD-EEEEE",
  payment_request: "lnbc10u1fake",
  payment_hash: "hash1",
  expires_at: "2027-07-18T12:00:00Z",
  price_sats: 1000,
  provider: "lnd",
};

describe("accountFromInvoice", () => {
  test("builds a pending account with source metadata", () => {
    const account = accountFromInvoice(
      invoice,
      {
        apiBase: "https://lnemail.net",
        sourceDomain: "forum.example.com",
        sourceUrl: "https://forum.example.com/signup",
      },
      NOW,
    );
    expect(account.status).toBe(ACCOUNT_STATUS.PENDING);
    expect(account.email).toBe(invoice.email_address);
    expect(account.token).toBe(invoice.access_token);
    expect(account.usedOn).toEqual([{ domain: "forum.example.com", at: NOW }]);
  });

  test("omits usage when created without a source", () => {
    const account = accountFromInvoice(
      invoice,
      { apiBase: "https://lnemail.net" },
      NOW,
    );
    expect(account.usedOn).toEqual([]);
    expect(account.sourceDomain).toBeNull();
  });
});

describe("upsertAccount and lookups", () => {
  test("replaces accounts by email", () => {
    const base = accountFromInvoice(invoice, { apiBase: "x" }, NOW);
    let accounts = upsertAccount([], base);
    accounts = upsertAccount(accounts, { ...base, status: ACCOUNT_STATUS.ACTIVE });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].status).toBe(ACCOUNT_STATUS.ACTIVE);
  });

  test("finds by signup and renewal payment hashes", () => {
    const account = {
      ...accountFromInvoice(invoice, { apiBase: "x" }, NOW),
      renewal: { paymentHash: "renew1" },
    };
    const accounts = [account];
    expect(findByPaymentHash(accounts, "hash1")).toBe(account);
    expect(findByRenewalHash(accounts, "renew1")).toBe(account);
    expect(findByPaymentHash(accounts, "nope")).toBeUndefined();
  });
});

describe("usage tracking", () => {
  test("recordUsage dedupes by domain and keeps latest timestamp", () => {
    let account = accountFromInvoice(
      invoice,
      { apiBase: "x", sourceDomain: "a.com" },
      NOW,
    );
    account = recordUsage(account, "b.com", NOW + 1);
    account = recordUsage(account, "a.com", NOW + 2);
    expect(account.usedOn).toEqual([
      { domain: "b.com", at: NOW + 1 },
      { domain: "a.com", at: NOW + 2 },
    ]);
  });

  test("accountsForDomain sorts by most recent use", () => {
    const a1 = recordUsage(
      accountFromInvoice({ ...invoice, email_address: "a@x" }, { apiBase: "x" }, NOW),
      "site.com",
      NOW - 100,
    );
    const a2 = recordUsage(
      accountFromInvoice({ ...invoice, email_address: "b@x" }, { apiBase: "x" }, NOW),
      "site.com",
      NOW,
    );
    const matches = accountsForDomain([a1, a2], "site.com");
    expect(matches.map((account) => account.email)).toEqual(["b@x", "a@x"]);
    expect(accountsForDomain([a1, a2], "other.com")).toEqual([]);
  });
});

describe("accountsNeedingRenewal", () => {
  test("selects active accounts inside the renewal window", () => {
    const soon = {
      email: "soon@x",
      status: ACCOUNT_STATUS.ACTIVE,
      expiresAt: new Date(NOW + 10 * DAY_MS).toISOString(),
    };
    const later = {
      email: "later@x",
      status: ACCOUNT_STATUS.ACTIVE,
      expiresAt: new Date(NOW + 100 * DAY_MS).toISOString(),
    };
    const pending = {
      email: "pending@x",
      status: ACCOUNT_STATUS.PENDING,
      expiresAt: new Date(NOW + 5 * DAY_MS).toISOString(),
    };
    const expired = {
      email: "expired@x",
      status: ACCOUNT_STATUS.EXPIRED,
      expiresAt: new Date(NOW - 5 * DAY_MS).toISOString(),
    };
    const result = accountsNeedingRenewal([soon, later, pending, expired], NOW, 30);
    expect(result.map((account) => account.email)).toEqual([
      "soon@x",
      "expired@x",
    ]);
  });
});

describe("latestUnread", () => {
  const header = (id, read, date, subject = `subject ${id}`) => ({
    id,
    subject,
    sender: `Sender <${id}@x>`,
    date,
    read,
  });

  test("keeps only unread, sorted newest first, limited", () => {
    const emails = [
      header("a", false, "Tue, 14 Jul 2026 10:00:00 GMT"),
      header("b", true, "Wed, 15 Jul 2026 10:00:00 GMT"),
      header("c", false, "Thu, 16 Jul 2026 10:00:00 GMT"),
      header("d", false, "Fri, 17 Jul 2026 10:00:00 GMT"),
      header("e", false, "Sat, 18 Jul 2026 10:00:00 GMT"),
    ];
    const preview = latestUnread(emails, 3);
    expect(preview.map((item) => item.id)).toEqual(["e", "d", "c"]);
  });

  test("excludes virtual expiry warnings", () => {
    const emails = [
      header("lnemail-expiry-warning-123", false, "Sat, 18 Jul 2026 10:00:00 GMT"),
      header("real", false, "Fri, 17 Jul 2026 10:00:00 GMT"),
    ];
    expect(latestUnread(emails).map((item) => item.id)).toEqual(["real"]);
  });

  test("truncates long subjects and senders", () => {
    const emails = [
      {
        id: "x",
        subject: "s".repeat(500),
        sender: "n".repeat(500),
        date: "Sat, 18 Jul 2026 10:00:00 GMT",
        read: false,
      },
    ];
    const [item] = latestUnread(emails);
    expect(item.subject).toHaveLength(120);
    expect(item.sender).toHaveLength(80);
  });

  test("tolerates unparsable dates and empty input", () => {
    const emails = [header("a", false, "not a date")];
    expect(latestUnread(emails)).toHaveLength(1);
    expect(latestUnread([])).toEqual([]);
    expect(latestUnread(undefined)).toEqual([]);
  });
});

describe("loadState", () => {
  test("merges defaults with stored settings", async () => {
    const area = {
      async get() {
        return { settings: { autoPayEnabled: true }, accounts: undefined };
      },
    };
    const state = await loadState(area);
    expect(state.settings.autoPayEnabled).toBe(true);
    expect(state.settings.apiBase).toBe(DEFAULT_SETTINGS.apiBase);
    expect(state.accounts).toEqual([]);
    expect(state.spendHistory).toEqual([]);
  });
});
