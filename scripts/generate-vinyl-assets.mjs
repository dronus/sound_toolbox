// One-off asset generator for Frieve Vinyl Explained.
// Emits the master app icon, PWA icon sizes, and the per-tool OGP image.
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const toolDir = path.join(root, 'vinyl_explained');
const baseOgp = path.join(root, 'public', 'ogp_base.jpg');

const iconSvg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="disc" cx="50%" cy="48%" r="58%">
      <stop offset="0%" stop-color="#4b4b45"/>
      <stop offset="34%" stop-color="#1f1f1d"/>
      <stop offset="100%" stop-color="#090909"/>
    </radialGradient>
    <linearGradient id="stylus" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f6f1df"/>
      <stop offset="48%" stop-color="#9fc7f4"/>
      <stop offset="100%" stop-color="#2469c2"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="190" fill="#0d0d0d"/>
  <circle cx="512" cy="512" r="368" fill="url(#disc)"/>
  <circle cx="512" cy="512" r="54" fill="#c98500"/>
  <circle cx="512" cy="512" r="18" fill="#0d0d0d"/>
  <g fill="none" stroke-linecap="round" opacity="0.92">
    <circle cx="512" cy="512" r="126" stroke="#2b2b28" stroke-width="10"/>
    <circle cx="512" cy="512" r="178" stroke="#33332f" stroke-width="7"/>
    <circle cx="512" cy="512" r="231" stroke="#2e2e2b" stroke-width="6"/>
    <circle cx="512" cy="512" r="286" stroke="#383832" stroke-width="5"/>
    <path d="M196 620c88-38 149-42 222-10 52 23 110 24 178 4 84-24 151-16 231 29" stroke="#3987e5" stroke-width="18"/>
    <path d="M202 663c91-30 153-29 219 4 58 29 123 30 195 0 79-33 146-31 222 3" stroke="#199e70" stroke-width="10"/>
  </g>
  <g filter="url(#shadow)">
    <path d="M672 90l122 56-242 455-90-42z" fill="#d9d2ba"/>
    <path d="M462 559l90 42-72 142-86 43z" fill="url(#stylus)"/>
    <path d="M386 785l94-42-32 108z" fill="#f8fbff"/>
    <path d="M672 90l122 56-31 58-123-56z" fill="#7d8588"/>
  </g>
  <path d="M280 810c116 54 264 71 410 22" fill="none" stroke="#ffffff" stroke-width="10" stroke-linecap="round" opacity="0.88"/>
</svg>`);

const ogpOverlay = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="soft" x="-20%" y="-40%" width="140%" height="180%">
      <feDropShadow dx="0" dy="2" stdDeviation="8" flood-color="#000000" flood-opacity="0.7"/>
    </filter>
  </defs>
  <text x="600" y="448" text-anchor="middle" dominant-baseline="middle"
        font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="84"
        fill="#ffffff" filter="url(#soft)">Vinyl Explained</text>
</svg>`);

const master = path.join(toolDir, 'icon.png');
await sharp(iconSvg).png({ compressionLevel: 9, effort: 10 }).toFile(master);

for (const size of [192, 512]) {
  await sharp(master)
    .resize(size, size, { fit: 'cover' })
    .png({ compressionLevel: 9, effort: 10, palette: true, quality: 90 })
    .toFile(path.join(toolDir, `icon-${size}x${size}.png`));
}

await sharp(baseOgp)
  .composite([{ input: ogpOverlay, top: 0, left: 0 }])
  .jpeg({ quality: 86, mozjpeg: true })
  .toFile(path.join(toolDir, 'ogp.jpg'));

console.log('Generated vinyl_explained icon and OGP assets.');
