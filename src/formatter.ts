export interface CgenFormatOptions {
  indentSize?: number;
  finalNewline?: boolean;
  maxBlankLines?: number;
}

export interface CgenFormattedEdit {
  text: string;
  cursor: number;
}

interface IndentFrame {
  sourceIndent: number;
}

const defaultOptions: Required<CgenFormatOptions> = {
  indentSize: 4,
  finalNewline: true,
  maxBlankLines: 1
};

export function formatCgen(source: string, options: CgenFormatOptions = {}): string {
  return formatCgenWithCursor(source, 0, options).text;
}

export function formatCgenWithCursor(
  source: string,
  cursor: number,
  options: CgenFormatOptions = {}
): CgenFormattedEdit {
  const config = { ...defaultOptions, ...options };
  const normalized = source.replace(/\r\n?/g, '\n');
  const sourceLines = normalized.split('\n');
  const sourceHadFinalNewline = sourceLines.length > 1 && sourceLines[sourceLines.length - 1] === '';
  if (sourceHadFinalNewline) {
    sourceLines.pop();
  }

  const formattedLines: string[] = [];
  const frames: IndentFrame[] = [];
  let blankCount = 0;
  let formattedCursor = 0;
  let sourceOffset = 0;
  let cursorMapped = false;

  for (const rawLine of sourceLines) {
    const lineStart = sourceOffset;
    const lineEnd = lineStart + rawLine.length;
    const expandedLine = expandLeadingTabs(rawLine, config.indentSize).trimEnd();
    const trimmed = expandedLine.trim();

    if (trimmed.length === 0) {
      if (formattedLines.length > 0 && blankCount < config.maxBlankLines) {
        if (!cursorMapped && cursor <= lineEnd) {
          formattedCursor = renderedLength(formattedLines);
          cursorMapped = true;
        }
        formattedLines.push('');
        blankCount += 1;
      }
      sourceOffset = lineEnd + 1;
      continue;
    }

    blankCount = 0;
    const sourceIndent = countLeadingSpaces(expandedLine);
    while (frames.length > 0 && sourceIndent <= frames[frames.length - 1].sourceIndent) {
      frames.pop();
    }

    const indent = ' '.repeat(frames.length * config.indentSize);
    const formattedLine = `${indent}${trimmed}`;
    if (!cursorMapped && cursor <= lineEnd) {
      const rawColumn = Math.max(0, cursor - lineStart);
      formattedCursor = renderedLength(formattedLines) + mapCursorColumn(rawLine, trimmed, indent.length, rawColumn, config.indentSize);
      cursorMapped = true;
    }

    formattedLines.push(formattedLine);
    if (opensBlock(trimmed)) {
      frames.push({ sourceIndent });
    }
    sourceOffset = lineEnd + 1;
  }

  while (formattedLines.length > 0 && formattedLines[formattedLines.length - 1] === '') {
    formattedLines.pop();
  }

  let text = formattedLines.join('\n');
  if (config.finalNewline && text.length > 0) {
    text += '\n';
  }

  if (!cursorMapped) {
    formattedCursor = text.length;
  }

  return {
    text,
    cursor: Math.min(formattedCursor, text.length)
  };
}

function opensBlock(trimmedLine: string): boolean {
  return /:\s*(?:#.*)?$/.test(trimmedLine);
}

function expandLeadingTabs(line: string, indentSize: number): string {
  const match = line.match(/^[\t ]*/)?.[0] ?? '';
  const expanded = match.replace(/\t/g, ' '.repeat(indentSize));
  return `${expanded}${line.slice(match.length)}`;
}

function countLeadingSpaces(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function renderedLength(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

function mapCursorColumn(
  rawLine: string,
  trimmedLine: string,
  formattedIndentLength: number,
  rawColumn: number,
  indentSize: number
): number {
  const expandedLine = expandLeadingTabs(rawLine, indentSize).trimEnd();
  const sourceIndentLength = countLeadingSpaces(expandedLine);
  const expandedColumn = expandLeadingTabs(rawLine.slice(0, rawColumn), indentSize).length;
  if (expandedColumn <= sourceIndentLength) {
    return formattedIndentLength;
  }

  return Math.min(formattedIndentLength + expandedColumn - sourceIndentLength, formattedIndentLength + trimmedLine.length);
}
