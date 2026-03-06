import { parentPort } from 'node:worker_threads';
import { PNG } from 'pngjs';

function asciiQrToPngDataUrl(blockLines, { scale = 2, border = 2 } = {}) {
  // The terminal QR uses Unicode block characters that represent *two* vertical pixels per cell:
  // - ' ' => white/white
  // - '█' => black/black
  // - '▀' => black(top) / white(bottom)
  // - '▄' => white(top) / black(bottom)
  const lines = blockLines.slice();
  const w = Math.max(...lines.map(l => l.length));
  const h = lines.length;

  const cellH = 2;
  const imgW = (w + border*2) * scale;
  const imgH = (h*cellH + border*2) * scale;
  const png = new PNG({ width: imgW, height: imgH });

  function setPixel(x,y,r,g,b,a=255){
    const idx = (png.width*y + x) << 2;
    png.data[idx]=r; png.data[idx+1]=g; png.data[idx+2]=b; png.data[idx+3]=a;
  }

  // fill white
  for (let y=0;y<imgH;y++) for (let x=0;x<imgW;x++) setPixel(x,y,255,255,255,255);

  function cellBits(ch){
    if (ch === '█') return [1,1];
    if (ch === '▀') return [1,0];
    if (ch === '▄') return [0,1];
    return [0,0];
  }

  for (let yy=0; yy<h; yy++) {
    const line = lines[yy].padEnd(w, ' ');
    for (let xx=0; xx<w; xx++) {
      const [top, bottom] = cellBits(line[xx]);
      const px0 = (xx + border) * scale;
      const pyTop = (yy*2 + border) * scale;
      const pyBot = (yy*2 + 1 + border) * scale;

      if (top) {
        for (let sy=0; sy<scale; sy++) for (let sx=0; sx<scale; sx++) setPixel(px0+sx, pyTop+sy, 0,0,0,255);
      }
      if (bottom) {
        for (let sy=0; sy<scale; sy++) for (let sx=0; sx<scale; sx++) setPixel(px0+sx, pyBot+sy, 0,0,0,255);
      }
    }
  }

  const buf = PNG.sync.write(png);
  return 'data:image/png;base64,' + buf.toString('base64');
}

parentPort.on('message', (msg) => {
  try {
    const { uuid, hash, lines, scale, border } = msg || {};
    if (!uuid || !hash || !Array.isArray(lines) || !lines.length) {
      parentPort.postMessage({ ok:false, uuid, hash, error:'bad_input' });
      return;
    }
    const dataUrl = asciiQrToPngDataUrl(lines, { scale: scale ?? 2, border: border ?? 1 });
    parentPort.postMessage({ ok:true, uuid, hash, dataUrl });
  } catch (e) {
    parentPort.postMessage({ ok:false, error: String(e?.message || e) });
  }
});
