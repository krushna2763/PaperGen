// Generates client/src/fonts/LiberationSerif.js — a pdfmake font container with
// base64-embedded Liberation Serif TTFs (SIL OFL 1.1; metric-compatible with
// Times New Roman, the font family used by the reference paper).
//
// The TTFs are NOT committed (only the generated module is). To regenerate,
// drop LiberationSerif-Regular.ttf + LiberationSerif-Bold.ttf into
// client/src/fonts/ first — e.g. from the liberation-fonts release
// (https://github.com/liberationfonts/liberation-fonts/releases, the
// liberation-fonts-ttf-2.1.5.tar.gz asset), then run:
//   node scripts/gen-font-module.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fontDir = path.join(__dirname, '..', 'client', 'src', 'fonts');
const outFile = path.join(fontDir, 'LiberationSerif.js');

const enc = (name) => fs.readFileSync(path.join(fontDir, name)).toString('base64');

const moduleSrc = `// Auto-generated font container for pdfmake (Liberation Serif, SIL OFL 1.1).
// Metric-compatible with Times New Roman, the body font of the reference paper.
// Lazy-loaded only when a PDF is actually rendered.
// Regenerate with: node scripts/gen-font-module.mjs
const fontContainer = {
  vfs: {
    'LiberationSerif-Regular.ttf': { data: "${enc('LiberationSerif-Regular.ttf')}" },
    'LiberationSerif-Bold.ttf': { data: "${enc('LiberationSerif-Bold.ttf')}" },
  },
  fonts: {
    'Liberation Serif': {
      normal: 'LiberationSerif-Regular.ttf',
      bold: 'LiberationSerif-Bold.ttf',
      italics: 'LiberationSerif-Regular.ttf',
      bolditalics: 'LiberationSerif-Bold.ttf',
    },
  },
};

export default fontContainer;
`;

fs.writeFileSync(outFile, moduleSrc);
console.log(`Wrote ${outFile} (${(moduleSrc.length / 1024).toFixed(0)} KB)`);
