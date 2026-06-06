// @ts-check
const fs = require('fs');
const path = require('path');
const { buildGrammar } = require('../src/tokenizer');

const out = path.join(__dirname, '../syntaxes/cgen.tmLanguage.json');
fs.writeFileSync(out, JSON.stringify(buildGrammar(), null, 2) + '\n');
console.log('Generated', out);
