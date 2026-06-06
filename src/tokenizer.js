// @ts-check
'use strict';

const keywords = require('./keywords.json');

const DOC_ATTR_NAMES = ['brief', 'doc'];
const DOC_ATTR_RE = new RegExp(`^(\\s*)(@(?:${DOC_ATTR_NAMES.join('|')}))(\\s*\\(.*)$`);

const INLINE_RE = new RegExp(
  `(@[A-Za-z_][A-Za-z0-9_]*|\\bc\\.[A-Za-z_][A-Za-z0-9_.]*\\b|"[^"]*"|[()[\\]{}]|${keywords.map((k) => `\\b${k}\\b`).join('|')})`,
  'g'
);

/** @param {string} text */
function classifyInlineToken(text) {
  if (/^@/.test(text)) return 'attr';
  if (/^c\./.test(text)) return 'builtin';
  if (/^"/.test(text)) return 'string';
  if (/^[()[\]{}]$/.test(text)) return 'bracket';
  return 'kw';
}

/**
 * @param {string} line
 * @returns {{ type: string, text: string }[]}
 */
function tokenizeLine(line) {
  const tokens = [];

  const docMatch = line.match(DOC_ATTR_RE);
  if (docMatch) {
    if (docMatch[1]) tokens.push({ type: 'plain', text: docMatch[1] });
    tokens.push({ type: 'attr', text: docMatch[2] });
    if (docMatch[3]) tokens.push({ type: 'plain', text: docMatch[3] });
    return tokens;
  }

  const commentIndex = line.indexOf('#');
  const rawCode = commentIndex === -1 ? line : line.slice(0, commentIndex);
  const comment = commentIndex === -1 ? '' : line.slice(commentIndex);

  INLINE_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = INLINE_RE.exec(rawCode)) !== null) {
    if (m.index > last) tokens.push({ type: 'plain', text: rawCode.slice(last, m.index) });
    tokens.push({ type: classifyInlineToken(m[0]), text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < rawCode.length) tokens.push({ type: 'plain', text: rawCode.slice(last) });

  if (comment) tokens.push({ type: 'comment', text: comment });

  return tokens;
}

const TM_SCOPES = {
  comment: 'comment.line.number-sign.cgen',
  attr:    'entity.other.attribute-name.cgen',
  kw:      'keyword.control.cgen',
  builtin: 'support.type.cgen',
  string:  'string.quoted.double.cgen',
};

function buildGrammar() {
  const kwPattern = `\\b(${keywords.join('|')})\\b`;
  return {
    scopeName: 'source.cgen',
    patterns: [
      { include: '#comments' },
      { include: '#doc_attributes' },
      { include: '#attributes' },
      { include: '#keywords' },
      { include: '#builtins' },
      { include: '#strings' },
    ],
    repository: {
      doc_attributes: {
        patterns: [{
          begin: `(@(?:${DOC_ATTR_NAMES.join('|')}))\\s*(\\()`,
          end: '\\)',
          beginCaptures: { '1': { name: TM_SCOPES.attr } },
          patterns: [],
        }],
      },
      attributes: {
        patterns: [{ name: TM_SCOPES.attr, match: '@[A-Za-z_][A-Za-z0-9_]*' }],
      },
      builtins: {
        patterns: [{ name: TM_SCOPES.builtin, match: '\\bc\\.[A-Za-z_][A-Za-z0-9_.]*\\b' }],
      },
      comments: {
        patterns: [{ name: TM_SCOPES.comment, match: '#.*$' }],
      },
      keywords: {
        patterns: [{ name: TM_SCOPES.kw, match: kwPattern }],
      },
      strings: {
        patterns: [{
          name: TM_SCOPES.string,
          begin: '"',
          end: '"',
          patterns: [{ name: 'constant.character.escape.cgen', match: '\\\\.' }],
        }],
      },
    },
  };
}

module.exports = { tokenizeLine, buildGrammar, DOC_ATTR_NAMES, TM_SCOPES };
