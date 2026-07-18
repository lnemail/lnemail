/**
 * Toolbar badge policy (pure).
 *
 * Attention items (accounts awaiting payment or nearing expiry) win
 * over unread counts: they are actionable and time-sensitive, so they
 * take the badge in orange. Otherwise the badge shows the total unread
 * emails across active accounts in blue. Empty when neither applies.
 */

import { ACCOUNT_STATUS, accountsNeedingRenewal } from "./store.js";

export const ATTENTION_COLOR = "#f7931a";
export const UNREAD_COLOR = "#1f6feb";

/**
 * Compute the toolbar badge for the current state.
 *
 * @param {object[]} accounts Stored accounts.
 * @param {{renewDaysBefore: number}} settings Current settings.
 * @param {number} now Epoch milliseconds.
 * @returns {{text: string, color: string, title: string}} Badge spec.
 */
export function computeBadge(accounts, settings, now) {
  const pending = (accounts ?? []).filter(
    (account) => account.status === ACCOUNT_STATUS.PENDING,
  ).length;
  const expiring = accountsNeedingRenewal(
    accounts,
    now,
    settings.renewDaysBefore,
  ).length;
  const attention = pending + expiring;
  if (attention > 0) {
    return {
      text: String(attention),
      color: ATTENTION_COLOR,
      title:
        attention === 1
          ? "LNemail: 1 account needs attention"
          : `LNemail: ${attention} accounts need attention`,
    };
  }

  const unread = (accounts ?? [])
    .filter((account) => account.status === ACCOUNT_STATUS.ACTIVE)
    .reduce((total, account) => total + (account.unreadCount ?? 0), 0);
  if (unread > 0) {
    return {
      text: unread > 99 ? "99+" : String(unread),
      color: UNREAD_COLOR,
      title:
        unread === 1
          ? "LNemail: 1 unread email"
          : `LNemail: ${unread} unread emails`,
    };
  }

  return { text: "", color: UNREAD_COLOR, title: "LNemail" };
}
