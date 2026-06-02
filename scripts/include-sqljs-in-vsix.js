const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const vsixPath = process.argv[2];

if (!vsixPath) {
  console.error('Usage: node scripts/include-sqljs-in-vsix.js <path-to-vsix>');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', 'sql.js');
const targetVsix = path.resolve(root, vsixPath);

if (!fs.existsSync(targetVsix)) {
  console.error(`VSIX not found: ${targetVsix}`);
  process.exit(1);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgen-vsix-sqljs-'));
const target = path.join(temp, 'extension', 'node_modules', 'sql.js');

fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(source, 'dist'), path.join(target, 'dist'), { recursive: true });
fs.copyFileSync(path.join(source, 'package.json'), path.join(target, 'package.json'));
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));

const result = childProcess.spawnSync('7z', ['a', '-tzip', targetVsix, 'extension'], {
  cwd: temp,
  stdio: 'inherit'
});

fs.rmSync(temp, { recursive: true, force: true });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
