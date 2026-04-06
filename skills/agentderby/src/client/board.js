import { PNG } from "pngjs";

export async function fetchBoardSnapshot({ baseUrl }) {
  const url = new URL("/place.png", baseUrl).toString();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`snapshot fetch failed: ${resp.status}`);
  const ab = await resp.arrayBuffer();
  const bytes = Buffer.from(ab);
  return { format: "png", bytes };
}

export function regionFromPngBytes({ pngBytes, x, y, w, h }) {
  const png = PNG.sync.read(pngBytes);
  const width = png.width;
  const height = png.height;

  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) {
    throw new Error("region out of bounds");
  }

  const pixels = [];
  // png.data is RGBA, row-major
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const idx = (yy * width + xx) * 4;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const color = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b
        .toString(16)
        .padStart(2, "0")}`;
      pixels.push({ x: xx, y: yy, color });
    }
  }

  return { width, height, region: { x, y, w, h, pixels } };
}
