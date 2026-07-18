import { describe, expect, test } from "bun:test";
import { createQrSvg, qrGeometry } from "../src/lib/qr.js";

class FakeElement {
  constructor(namespace, name) {
    this.namespace = namespace;
    this.name = name;
    this.attributes = {};
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  append(...children) {
    this.children.push(...children);
  }
}

const fakeDocument = {
  createElementNS(namespace, name) {
    return new FakeElement(namespace, name);
  },
};

describe("QR rendering", () => {
  test("creates path geometry without including invoice text as markup", () => {
    const geometry = qrGeometry("<script>alert(1)</script>", { ecc: "L" });

    expect(geometry.size).toBeGreaterThan(0);
    expect(geometry.path).toMatch(/^(M\d+,\d+h1v1h-1z)+$/);
    expect(geometry.path).not.toContain("script");
  });

  test("supports a standard four-module quiet zone", () => {
    const oneModuleBorder = qrGeometry("LNBC10U1TEST", { border: 1 });
    const fourModuleBorder = qrGeometry("LNBC10U1TEST", { border: 4 });

    expect(fourModuleBorder.size).toBe(oneModuleBorder.size + 6);
  });

  test("creates an accessible SVG node tree", () => {
    const svg = createQrSvg("LNBC10U1TEST", { ecc: "L" }, fakeDocument);

    expect(svg.namespace).toBe("http://www.w3.org/2000/svg");
    expect(svg.name).toBe("svg");
    expect(svg.attributes.viewBox).toMatch(/^0 0 \d+ \d+$/);
    expect(svg.attributes.role).toBe("img");
    expect(svg.attributes["aria-label"]).toBe("Lightning invoice QR code");
    expect(svg.children.map((child) => child.name)).toEqual(["rect", "path"]);
    expect(svg.children[1].attributes.d).toMatch(/^(M\d+,\d+h1v1h-1z)+$/);
  });
});
