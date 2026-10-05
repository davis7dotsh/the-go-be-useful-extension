import { build } from 'esbuild';
import { rm, mkdir, cp, readdir, readFile, writeFile } from 'node:fs/promises';

const browser = process.argv[2] ?? 'helium';
if (browser !== 'helium' && browser !== 'zen') throw new Error(`Unknown browser: ${browser}`);
const outdir = browser === 'zen' ? 'dist-zen' : 'dist';
await mkdir(outdir, { recursive: true });
for (const entry of await readdir(outdir)) await rm(`${outdir}/${entry}`, { recursive: true, force: true });
await build({ entryPoints: ['src/background.ts', 'src/content/guard.ts', 'src/popup/index.ts'], outdir, outbase: 'src', bundle: true, format: 'iife', target: browser === 'zen' ? 'firefox128' : 'chrome120', legalComments: 'none', loader: { '.css': 'text' } });
const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
if (browser === 'zen') {
  delete manifest.minimum_chrome_version;
  manifest.background = { scripts: ['background.js'] };
  manifest.browser_specific_settings = { gecko: {
    id: 'focus@davis7.sh',
    strict_min_version: '142.0',
    data_collection_permissions: { required: ['none'] },
  } };
}
await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
await cp('src/icons', `${outdir}/icons`, { recursive: true });
await cp('src/assets', `${outdir}/assets`, { recursive: true });
for (const dir of ['popup','blocked']) for (const file of ['index.html','styles.css']) await cp(`src/${dir}/${file}`, `${outdir}/${dir}/${file}`);
console.log(`Built self-contained ${browser === 'zen' ? 'Zen' : 'Helium'} extension in ${outdir}/`);
