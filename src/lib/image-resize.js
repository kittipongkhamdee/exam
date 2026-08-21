// image-resize.js
//
// Client-side image downscale/re-encode via canvas — for uploads (like the
// exam system's logo) stored inline as a data: URL in a text config value
// rather than in Storage, where the raw image bytes need to fit a fixed
// budget instead of just being rejected when the teacher's file is too big.
//
// Tries PNG first (lossless, keeps transparency) at a capped dimension;
// if that's still over budget, falls back to JPEG (opaque, flattened onto
// white — JPEG has no alpha channel) at decreasing quality; if even the
// smallest JPEG quality is still over budget, shrinks the dimension
// further and repeats. A small logo (shown at most a few dozen pixels on
// screen, LOGO_SIZE=56 in exam-print.js) never legitimately needs more
// than a few hundred pixels on a side, so this converges quickly in
// practice.

const DEFAULT_MAX_DIMENSION = 320;
const JPEG_QUALITIES = [0.85, 0.7, 0.55, 0.4];
const MAX_ATTEMPTS = 6;

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('อ่านไฟล์รูปภาพไม่สำเร็จ')); };
    img.src = url;
  });
}

function canvasToDataUrl(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) { reject(new Error('แปลงรูปภาพไม่สำเร็จ')); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('แปลงรูปภาพไม่สำเร็จ'));
      reader.readAsDataURL(blob);
    }, mimeType, quality);
  });
}

// Raw byte size of the data the data: URL encodes (base64 inflates length
// by ~4/3), not the string length itself — matches what a plain
// file.size check would have measured.
function dataUrlByteLength(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.ceil((base64.length * 3) / 4);
}

/**
 * Downscales/re-encodes an image file into a data: URL guaranteed to be
 * <= maxBytes, resizing down (and falling back to JPEG) as far as it
 * takes.
 * @param {File} file
 * @param {{ maxDimension?: number, maxBytes: number }} opts
 * @returns {Promise<string>}
 */
export async function resizeImageToFit(file, { maxDimension = DEFAULT_MAX_DIMENSION, maxBytes }) {
  const img = await loadImageFromFile(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  function draw(dim, whiteBg) {
    const scale = Math.min(1, dim / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (whiteBg) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  let dim = maxDimension;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    draw(dim, false);
    const pngUrl = await canvasToDataUrl(canvas, 'image/png');
    if (dataUrlByteLength(pngUrl) <= maxBytes) return pngUrl;

    for (const quality of JPEG_QUALITIES) {
      draw(dim, true);
      const jpegUrl = await canvasToDataUrl(canvas, 'image/jpeg', quality);
      if (dataUrlByteLength(jpegUrl) <= maxBytes) return jpegUrl;
    }

    dim = Math.round(dim * 0.7);
  }

  throw new Error('ไม่สามารถย่อรูปภาพให้มีขนาดเล็กพอได้ กรุณาเลือกรูปอื่น');
}
