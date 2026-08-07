/* File/Blob → canvas, including HEIC (iPhone default format), with downscale. */

/** HEIC/HEIF detection by ISO-BMFF magic bytes — browsers often report an
 * empty MIME type for .heic files, so the extension cannot be trusted. */
export function isHeic(buffer) {
  if (buffer.byteLength < 12) return false;
  const b = new Uint8Array(buffer, 0, 12);
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) !== 'ftyp') return false;
  const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
  return ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand);
}

let libheifPromise = null;

function loadLibheif() {
  if (!libheifPromise) {
    const url = new URL('../vendor/libheif/libheif-bundle.js', import.meta.url).href;
    libheifPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => {
        if (window.libheif && window.libheif.HeifDecoder) resolve(window.libheif);
        else reject(new Error('libheif loaded but HeifDecoder is missing'));
      };
      s.onerror = () => reject(new Error('Could not load the HEIC decoder.'));
      document.head.appendChild(s);
    });
  }
  return libheifPromise;
}

async function decodeHeicToCanvas(buffer) {
  const libheif = await loadLibheif();
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(buffer);
  if (!images || images.length === 0) throw new Error('No image found inside the HEIC file.');
  const img = images[0];
  const w = img.get_width();
  const h = img.get_height();
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(w, h);
  await new Promise((resolve, reject) => {
    img.display(imageData, (ok) => ok ? resolve() : reject(new Error('HEIC decode failed.')));
  });
  ctx.putImageData(imageData, 0, 0);
  for (const im of images) { try { im.free(); } catch (_) {} }
  return canvas;
}

function scaleToMaxEdge(canvas, maxEdge) {
  const long = Math.max(canvas.width, canvas.height);
  if (long <= maxEdge) return canvas;
  const s = maxEdge / long;
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * s);
  out.height = Math.round(canvas.height * s);
  out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/**
 * Decode any supported image (JPEG/PNG/WebP natively, HEIC via libheif) to a
 * canvas whose long edge is at most maxEdge. Throws Error with a user-facing
 * message on unsupported or corrupt input.
 */
export async function decodeToCanvas(fileOrBlob, maxEdge = 2000) {
  const buffer = await fileOrBlob.arrayBuffer();

  if (isHeic(buffer)) {
    return scaleToMaxEdge(await decodeHeicToCanvas(buffer), maxEdge);
  }

  let bmp;
  try {
    bmp = await createImageBitmap(fileOrBlob, { colorSpaceConversion: 'none' });
  } catch (_) {
    try {
      bmp = await createImageBitmap(fileOrBlob);
    } catch (_2) {
      throw new Error('That file could not be read as an image. JPG, PNG, WebP and HEIC are supported.');
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return scaleToMaxEdge(canvas, maxEdge);
}
