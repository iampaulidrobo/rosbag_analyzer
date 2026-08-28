import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'node_modules', 'plotly.js-dist-min', 'plotly.min.js');
const destDir = path.join(root, 'media', 'vendor');
const dest = path.join(destDir, 'plotly.min.js');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`vendored ${src} -> ${dest}`);
