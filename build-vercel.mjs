import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const kitRevision = '1e4291e2fa4896b1f603d3d4f0b009c483425da0';
const kitRepository = 'https://github.com/VexoAI-Org/vexo-open-kit.git';
const kit = mkdtempSync(join(tmpdir(), 'vexo-kit-'));

try {
  execFileSync('git', ['init', '--quiet', kit], { stdio: 'inherit' });
  execFileSync('git', ['-C', kit, 'fetch', '--depth=1', kitRepository, kitRevision], { stdio: 'inherit' });
  execFileSync('git', ['-C', kit, 'checkout', '--quiet', 'FETCH_HEAD'], { stdio: 'inherit' });

  for (const page of ['gesture-speak', 'shape-test']) {
    cpSync(page, join('dist', page), { recursive: true });
  }
  mkdirSync('dist/shared', { recursive: true });
  for (const asset of ['icon.png', 'kit.js', 'page.js', 'style.css']) {
    cpSync(join('shared', asset), join('dist/shared', asset));
  }
  cpSync(join(kit, 'js/src'), 'dist/vexo-open-kit/js/src', { recursive: true });
  cpSync(join(kit, 'LICENSE'), 'dist/vexo-open-kit/LICENSE');
  mkdirSync('dist/vexo-open-kit/dashboard/speech', { recursive: true });
  cpSync(join(kit, 'dashboard/speech/sample-speech.opus'), 'dist/vexo-open-kit/dashboard/speech/sample-speech.opus');
} finally {
  rmSync(kit, { recursive: true, force: true });
}
