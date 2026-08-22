// qr.js — turns a URL/text into an inline SVG path for print. Uses
// QRCode.create() (the 'qrcode' package's synchronous matrix builder, no
// canvas/DOM/network involved) so it renders identically in the printed
// page as on screen, with no external image request that could fail or be
// blocked while printing offline.
import QRCode from 'qrcode';

export function qrSvgPath(text, { errorCorrectionLevel = 'M' } = {}) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel });
  const { size, data } = modules;
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[y * size + x]) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return { d, size };
}
