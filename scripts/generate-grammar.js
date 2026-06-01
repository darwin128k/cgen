// @ts-check
const fs = require('fs');
const path = require('path');

const keywords = require('../src/keywords.json');
const kwPattern = `\\b(${keywords.join('|')})\\b`;

const grammar = {
  scopeName: 'source.cgen',
  patterns: [
    { include: '#comments' },
    { include: '#attributes' },
    { include: '#keywords' },
    { include: '#builtins' },
    { include: '#strings' }
  ],
  repository: {
    attributes: {
      patterns: [{ name: 'entity.other.attribute-name.cgen', match: '@[A-Za-z_][A-Za-z0-9_]*' }]
    },
    builtins: {
      patterns: [{ name: 'support.type.cgen', match: '\\bc\\.[A-Za-z_][A-Za-z0-9_.]*\\b' }]
    },
    comments: {
      patterns: [{ name: 'comment.line.number-sign.cgen', match: '#.*$' }]
    },
    keywords: {
      patterns: [{ name: 'keyword.control.cgen', match: kwPattern }]
    },
    strings: {
      patterns: [{
        name: 'string.quoted.double.cgen',
        begin: '"',
        end: '"',
        patterns: [{ name: 'constant.character.escape.cgen', match: '\\\\.' }]
      }]
    }
  }
};

const out = path.join(__dirname, '../syntaxes/cgen.tmLanguage.json');
fs.writeFileSync(out, JSON.stringify(grammar, null, 2) + '\n');
console.log('Generated', out);
