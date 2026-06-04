const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'node_modules', 'sql.js', 'dist');
const dst = path.join(root, 'out', 'sqljs');

fs.mkdirSync(dst, { recursive: true });
fs.cpSync(src, dst, { recursive: true });
console.log('sql.js dist copied to out/sqljs/');
