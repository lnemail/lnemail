import { describe, expect, test } from "bun:test";

const extensionRoot = new URL("../", import.meta.url);

describe("Firefox publication metadata", () => {
  test("requires versions that support data collection permissions", async () => {
    const manifest = await Bun.file(
      new URL("src/manifest.firefox.json", extensionRoot),
    ).json();

    expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe(
      "142.0",
    );
    expect(manifest.browser_specific_settings.gecko_android).toBeUndefined();
    expect(
      manifest.browser_specific_settings.gecko.data_collection_permissions,
    ).toEqual({
      required: [
        "authenticationInfo",
        "financialAndPaymentInfo",
        "personalCommunications",
      ],
    });
  });

  test("extension UI code does not assign HTML strings", async () => {
    const sourcePaths = [
      "src/popup/popup.js",
      "src/content/autofill.js",
    ];

    for (const sourcePath of sourcePaths) {
      const source = await Bun.file(new URL(sourcePath, extensionRoot)).text();
      expect(source).not.toContain(".innerHTML");
    }
  });

  test("toolbar popup keeps a stable intrinsic width", async () => {
    const css = await Bun.file(
      new URL("src/popup/popup.css", extensionRoot),
    ).text();

    expect(css).toMatch(/body\s*{[^}]*width:\s*380px/);
    expect(css).not.toMatch(/max-width:\s*100vw/);
  });
});
