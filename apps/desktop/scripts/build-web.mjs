// Builds the website (web/build.py, MODE='web') into ./web for the app. The serverless API and Vercel files stay
// out: the app talks to justwatts.com for those.
import { execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..'), out = path.resolve(here, '../web');
const pythons = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
let done = false;
for (const py of pythons) {
  try { execFileSync(py, [path.join(repo, 'web/build.py'), '--out', out], { stdio: 'inherit' }); done = true; break; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
if (!done) throw new Error('python not found (needed for web/build.py)');
for (const f of ['api', 'package.json', 'package-lock.json', '.vercel']) if (existsSync(path.join(out, f))) rmSync(path.join(out, f), { recursive: true, force: true });
