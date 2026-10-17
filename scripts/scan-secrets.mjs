import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
const paths = execFileSync(
  'git',
  ['ls-files', '-co', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{24,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];
let failed = false;
for (const path of paths) {
  if (!lstatSync(path).isFile() || path.endsWith('package-lock.json')) continue;
  const text = readFileSync(path, 'utf8');
  for (const pattern of patterns)
    if (pattern.test(text)) {
      console.error(
        `Potential secret in ${path} (${pattern.source.slice(0, 24)}).`,
      );
      failed = true;
    }
}
if (failed) process.exit(1);
console.log(
  `Secret scan passed (${paths.length} repository files; values are never printed).`,
);
