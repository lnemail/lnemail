/**
 * Privacy policy for automatic server polling.
 *
 * Default installs poll only during a short activity window following an
 * explicit extension interaction. Continuous polling requires an opt-in.
 */

export const POLLING_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
export const UNREAD_ACTIVITY_PERIOD_MINUTES = 1;
export const UNREAD_BACKGROUND_PERIOD_MINUTES = 15;

export const BACKGROUND_POLLING_MODE = {
  OFF: "off",
  ACTIVITY: "activity",
  BACKGROUND: "background",
};

/**
 * Select the server polling mode without touching browser state.
 *
 * @param {{backgroundPollingEnabled?: boolean}} settings Settings.
 * @param {number | null | undefined} activeUntil Activity expiry timestamp.
 * @param {number} now Current timestamp.
 * @returns {string} One of BACKGROUND_POLLING_MODE.
 */
export function backgroundPollingMode(settings, activeUntil, now) {
  if (settings.backgroundPollingEnabled) {
    return BACKGROUND_POLLING_MODE.BACKGROUND;
  }
  if (Number.isFinite(activeUntil) && activeUntil > now) {
    return BACKGROUND_POLLING_MODE.ACTIVITY;
  }
  return BACKGROUND_POLLING_MODE.OFF;
}
