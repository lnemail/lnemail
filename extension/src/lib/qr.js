import { encode } from "uqr";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function qrGeometry(data, options = {}) {
  const qr = encode(data, options);
  const commands = [];

  for (let row = 0; row < qr.size; row++) {
    for (let column = 0; column < qr.size; column++) {
      if (qr.data[row][column]) {
        commands.push(`M${column},${row}h1v1h-1z`);
      }
    }
  }

  return { size: qr.size, path: commands.join("") };
}

export function createQrSvg(data, options = {}, documentRef = document) {
  const { size, path: pathData } = qrGeometry(data, options);
  const svg = documentRef.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Lightning invoice QR code");
  svg.setAttribute("shape-rendering", "crispEdges");

  const background = documentRef.createElementNS(SVG_NAMESPACE, "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", "white");

  const modules = documentRef.createElementNS(SVG_NAMESPACE, "path");
  modules.setAttribute("d", pathData);
  modules.setAttribute("fill", "black");

  svg.append(background, modules);
  return svg;
}
