export interface DoxygenTextFormatOptions {
  softColumn?: number;
  hardColumn?: number;
}

const defaultOptions: Required<DoxygenTextFormatOptions> = {
  softColumn: 68,
  hardColumn: 77,
};

export function formatDoxygenText(text: string, options: DoxygenTextFormatOptions = {}): string[] {
  const config = { ...defaultOptions, ...options };
  const result: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\s+/g, ' ');
    if (line.length === 0) {
      result.push('');
      continue;
    }
    result.push(...wrapLine(line, config));
  }

  return result;
}

function wrapLine(line: string, config: Required<DoxygenTextFormatOptions>): string[] {
  const result: string[] = [];
  let rest = line;

  while (rest.length > config.hardColumn) {
    const breakAt = findBreak(rest, config);
    if (breakAt <= 0) { break; }
    result.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).trimStart();
  }

  result.push(rest);
  return result;
}

function findBreak(text: string, config: Required<DoxygenTextFormatOptions>): number {
  const minPunctuationColumn = Math.floor(config.softColumn * 0.6);
  const punctuationBreak = findLastPunctuationBreak(text, minPunctuationColumn, config.softColumn);
  if (punctuationBreak > 0) { return punctuationBreak; }

  const hardWhitespaceBreak = findLastWhitespaceBreak(text, config.hardColumn);
  if (hardWhitespaceBreak > 0) { return hardWhitespaceBreak; }

  const nextWhitespace = text.search(/\s/);
  return nextWhitespace > 0 ? nextWhitespace : text.length;
}

function findLastPunctuationBreak(text: string, minColumn: number, maxColumn: number): number {
  let result = -1;
  const pattern = /[.,;:]\s+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const breakAt = match.index + 1;
    if (breakAt > maxColumn) { break; }
    if (breakAt >= minColumn) { result = breakAt; }
  }
  return result;
}

function findLastWhitespaceBreak(text: string, maxColumn: number): number {
  let result = -1;
  const pattern = /\s+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > maxColumn) { break; }
    result = match.index;
  }
  return result;
}
