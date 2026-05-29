export interface SnippetEdit {
  text: string;
  selection?: { start: number; end: number };
  tabStops?: Array<{ start: number; end: number }>;
}

export class SnippetEngine {
  private mode = false;
  private tabStopWords: string[] = [];

  get active(): boolean {
    return this.mode;
  }

  clear(): void {
    this.mode = false;
    this.tabStopWords = [];
  }

  activate(edit: SnippetEdit): void {
    this.mode = edit.tabStops !== undefined && edit.tabStops.length >= 1;
    if (!this.mode) {
      this.tabStopWords = [];
    }
  }

  setTabStopWords(words: string[]): void {
    this.tabStopWords = words;
  }

  tabStopRegex(global?: boolean): RegExp {
    const words = this.tabStopWords.length > 0
      ? this.tabStopWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
      : 'NAME|name|type|value|values';
    return new RegExp(`\\b(${words})\\b`, global ? 'g' : '');
  }

  extractTabStopWords(text: string): string[] {
    const match = text.match(/\(([^()]*)\)/);
    if (!match) { return []; }
    return match[1].split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
  }

  getSuggestionEdit(text: string): SnippetEdit {
    const placeholderRegex = this.tabStopRegex(true);
    const tabStops: Array<{ start: number; end: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = placeholderRegex.exec(text)) !== null) {
      tabStops.push({ start: match.index, end: match.index + match[0].length });
    }

    if (tabStops.length > 0) {
      return { text, selection: { start: tabStops[0].start, end: tabStops[0].end }, tabStops };
    }

    const emptyCall = text.indexOf('()');
    if (emptyCall !== -1) {
      return { text, selection: { start: emptyCall + 1, end: emptyCall + 1 } };
    }

    return { text };
  }

  advanceToNextTabStop(source: HTMLTextAreaElement): boolean {
    if (!this.mode) { return false; }

    const cursor = source.selectionEnd;
    const text = source.value;
    const lineEnd = text.indexOf('\n', cursor);
    const searchEnd = lineEnd === -1 ? text.length : lineEnd;
    const match = this.tabStopRegex().exec(text.slice(cursor, searchEnd));
    if (match !== null) {
      source.selectionStart = cursor + match.index;
      source.selectionEnd = cursor + match.index + match[0].length;
      return true;
    }

    this.mode = false;
    this.tabStopWords = [];
    return false;
  }

  highlightTabStops(
    lines: string[],
    cursorEnd: number,
    value: string,
    highlightLine: (line: string) => string,
    escapeHtml: (s: string) => string
  ): string {
    const lineEnd = value.indexOf('\n', cursorEnd);
    const searchEnd = lineEnd === -1 ? value.length : lineEnd;
    const searchRegion = value.slice(cursorEnd, searchEnd);
    const placeholderRegex = this.tabStopRegex(true);
    const tabStopPositions: Array<{ start: number; end: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = placeholderRegex.exec(searchRegion)) !== null) {
      tabStopPositions.push({ start: cursorEnd + match.index, end: cursorEnd + match.index + match[0].length });
    }

    if (tabStopPositions.length === 0) {
      return lines.map(highlightLine).join('\n');
    }

    let offset = 0;
    return lines.map((line) => {
      const lineStart = offset;
      offset = lineStart + line.length + 1;
      const lineTabStops = tabStopPositions.filter((ts) => ts.start >= lineStart && ts.end <= lineStart + line.length);
      if (lineTabStops.length === 0) { return highlightLine(line); }

      let result = '';
      let pos = 0;
      for (const ts of lineTabStops) {
        const start = ts.start - lineStart;
        const end = ts.end - lineStart;
        result += highlightLine(line.slice(pos, start));
        result += `<span class="tab-stop">${escapeHtml(line.slice(start, end))}</span>`;
        pos = end;
      }
      return result + highlightLine(line.slice(pos));
    }).join('\n');
  }
}
