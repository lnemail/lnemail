/**
 * Cross-browser WebExtension API shim.
 *
 * Firefox exposes a promise-based `browser` global; Chrome MV3 exposes
 * `chrome` whose APIs also return promises when no callback is passed.
 * Using whichever exists gives a single promise-based API surface.
 */
export const ext = globalThis.browser ?? globalThis.chrome;
