import { describe, expect, test } from "bun:test";
import {
  BACKGROUND_POLLING_MODE,
  POLLING_ACTIVITY_WINDOW_MS,
  backgroundPollingMode,
} from "../src/lib/background-polling.js";

const NOW = Date.parse("2026-07-30T12:00:00Z");

describe("backgroundPollingMode", () => {
  test("is off by default without recent user activity", () => {
    expect(backgroundPollingMode({}, null, NOW)).toBe(
      BACKGROUND_POLLING_MODE.OFF,
    );
    expect(backgroundPollingMode({}, NOW, NOW)).toBe(
      BACKGROUND_POLLING_MODE.OFF,
    );
  });

  test("allows polling during the five-minute activity window", () => {
    expect(
      backgroundPollingMode({}, NOW + POLLING_ACTIVITY_WINDOW_MS, NOW),
    ).toBe(BACKGROUND_POLLING_MODE.ACTIVITY);
  });

  test("keeps polling active after an explicit opt-in", () => {
    expect(backgroundPollingMode({ backgroundPollingEnabled: true }, null, NOW)).toBe(
      BACKGROUND_POLLING_MODE.BACKGROUND,
    );
  });

  test("rejects invalid activity timestamps", () => {
    expect(backgroundPollingMode({}, Number.NaN, NOW)).toBe(
      BACKGROUND_POLLING_MODE.OFF,
    );
    expect(backgroundPollingMode({}, "future", NOW)).toBe(
      BACKGROUND_POLLING_MODE.OFF,
    );
  });
});
