import { SnippetEngine } from './snippetEngine';
import { LineAttachmentController } from './lineAttachments';
import { formatCgenWithCursor } from '../../src/formatter';
import keywords from '../../src/keywords.json';
import { contextCandidates } from '../../src/completionRules';

declare function acquireVsCodeApi(): { postMessage(data: unknown): void };
declare global {
  interface Window {
    __cgenCursor: number;
    __cgenScroll: number;
    visualViewport?: { addEventListener(type: string, cb: () => void): void };
  }
}

const vscode = acquireVsCodeApi();
const source = document.getElementById('source') as HTMLTextAreaElement;
const highlight = document.getElementById('highlight')!;
const suggestion = document.getElementById('suggestion')!;
const lineNumbers = document.getElementById('lineNumbers')!;
const lineAttachmentsLayer = document.getElementById('lineAttachments')!;
const stripes = document.getElementById('stripes')!;
const errorLines = document.getElementById('errorLines')!;
const activeLine = document.getElementById('activeLine')!;
const generate = document.getElementById('generate')!;
const save = document.getElementById('save')!;
const load = document.getElementById('load')!;
const expand = document.getElementById('expand')!;
const progressBar = document.getElementById('progressBar')!;
let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
let suggestTimer: ReturnType<typeof setTimeout> | undefined;
let suggestRequestId = 0;
let suggestionInsertText = '';
let suggestionReplaceLeft = 0;
let popupAllowed = false;
let isDeletingKey = false;
const snippetEngine = new SnippetEngine();
let navHoverRange: { start: number; end: number } | undefined;
let stripeActiveLineIndex = -1;
let stripeHasSelection = false;
let stripeErrorCount = -1;
let scheduledPaintId: number | undefined;
let completionCandidates: string[] = [];
let completionInsertTexts: string[] = [];
let completionCandidateKinds: string[] = [];
let completionIndex = 0;
let completionContextKey = '';
let completionPrefix = '';
let lastContextCandidates: string[] = [];
let lastContextKey = '';
let formatPolicy = {
  formatOnSave: false,
  formatOnPaste: false
};

const completionList = document.createElement('div');
completionList.id = 'completionList';
completionList.className = 'completion-list';
completionList.hidden = true;
const lineAttachments = new LineAttachmentController({
  source,
  layer: lineAttachmentsLayer,
  getEditorPaddingTop,
  onAction: (action) => vscode.postMessage({ type: 'lineAttachmentAction', ...action })
});
let characterWidth: number | undefined;
let diagnosticLines: number[] = [];
let activeLineIndex = 0;
const indentText = '    ';
const highlightRegex = new RegExp(
  `(@[A-Za-z_][A-Za-z0-9_]*|\\bc\\.[A-Za-z_][A-Za-z0-9_.]*\\b|->|[()[\\]{}]|${keywords.map((k) => `\\b${k}\\b`).join('|')})`,
  'g'
);
let cachedLineHTMLs: string[] = [];
let cachedRawLines: string[] = [];
let stripeCount = 0;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function highlightToken(token: string): string {
  if (/^#.*$/.test(token)) {
    return `<span class="comment">${escapeHtml(token)}</span>`;
  }

  if (/^@[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
    return `<span class="attr">${escapeHtml(token)}</span>`;
  }

  if (keywords.includes(token as typeof keywords[number]) || token === '->') {
    return `<span class="kw">${escapeHtml(token)}</span>`;
  }

  if (/^[()[\]{}]$/.test(token)) {
    return `<span class="bracket">${escapeHtml(token)}</span>`;
  }

  if (/^c\./.test(token)) {
    return `<span class="builtin">${escapeHtml(token)}</span>`;
  }

  return escapeHtml(token);
}

function highlightLine(line: string): string {
  const commentIndex = line.indexOf('#');
  const rawCode = commentIndex === -1 ? line : line.slice(0, commentIndex);
  const comment = commentIndex === -1 ? '' : line.slice(commentIndex);
  highlightRegex.lastIndex = 0;
  const highlightedCode = escapeHtml(rawCode).replace(highlightRegex, highlightToken);
  return `${highlightedCode}${comment ? highlightToken(comment) : ''}`;
}

function highlightNavigationRange(lines: string[]): string {
  if (!navHoverRange) {
    return lines.map(highlightLine).join('\n');
  }

  let offset = 0;
  return lines.map((line) => {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + 1;

    if (navHoverRange!.end <= lineStart || navHoverRange!.start >= lineEnd) {
      return highlightLine(line);
    }

    const start = Math.max(0, navHoverRange!.start - lineStart);
    const end = Math.min(line.length, navHoverRange!.end - lineStart);
    return [
      highlightLine(line.slice(0, start)),
      `<span class="nav-token">${highlightLine(line.slice(start, end))}</span>`,
      highlightLine(line.slice(end))
    ].join('');
  }).join('\n');
}

function scrollTail(): string {
  return '<span class="scroll-tail" aria-hidden="true"></span>';
}

function highlightLinesWithGhost(lines: string[]): string {
  const cursor = source.selectionStart;
  const linesBefore = source.value.slice(0, cursor).split('\n');
  const cursorLineIndex = linesBefore.length - 1;
  const cursorCol = linesBefore[cursorLineIndex].length;
  let offset = 0;
  return lines.map((line, i) => {
    const lineStart = offset;
    offset += line.length + 1;
    if (i !== cursorLineIndex) {
      return highlightLine(line);
    }
    const before = line.slice(0, cursorCol - suggestionReplaceLeft);
    const after = line.slice(cursorCol);
    const highlightedAfter = snippetEngine.active
      ? snippetEngine.highlightPart(after, lineStart + cursorCol, source.value, highlightLine, escapeHtml)
      : highlightLine(after);
    return `${highlightLine(before)}<span class="ghost-text">${escapeHtml(suggestionInsertText)}</span>${highlightedAfter}`;
  }).join('\n');
}

function highlightLinesWithSelection(lines: string[]): string {
  const selectionStart = Math.min(source.selectionStart, source.selectionEnd);
  const selectionEnd = Math.max(source.selectionStart, source.selectionEnd);
  let offset = 0;

  return lines.map((line) => {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + 1;

    if (selectionEnd <= lineStart || selectionStart > lineEnd) {
      return highlightLine(line);
    }

    const start = Math.max(0, selectionStart - lineStart);
    const end = Math.min(line.length, selectionEnd - lineStart);
    const selectsLineBreak = selectionEnd > lineEnd && selectionStart <= lineEnd;
    const selectedText = line.slice(start, end);
    const lineBreakBlock = selectsLineBreak ? '<span class="selected-text selected-gap">&nbsp;</span>' : '';

    return [
      highlightLine(line.slice(0, start)),
      selectedText ? `<span class="selected-text">${highlightLine(selectedText)}</span>` : '',
      lineBreakBlock,
      highlightLine(line.slice(end))
    ].join('');
  }).join('\n');
}

function paint(): void {
  syncMetrics(false);
  paintHighlight();
  suggestion.textContent = '';

  const lineCount = Math.max(1, source.value.split('\n').length);
  lineNumbers.innerHTML = renderLineNumbers(lineCount);
  ensureStripeCount();
  renderErrorLines();
  updateSelectionMode();
  updateActiveLine();
  updateBreadcrumb();
  lineAttachments.render();
  syncScroll();
  requestAnimationFrame(syncScroll);
}

function schedulePaint(): void {
  if (scheduledPaintId === undefined) {
    scheduledPaintId = requestAnimationFrame(() => {
      scheduledPaintId = undefined;
      paint();
    });
  }
}

function renderLineNumbers(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => {
    const active = index === activeLineIndex ? ' active' : '';
    return `<span class="line-number${active}">${index + 1}</span>`;
  }).join('');
}

function ensureStripeCount(): void {
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
  const needed = Math.ceil((source.scrollTop + source.clientHeight) / lineHeight) + 24;
  if (needed <= stripeCount && document.getElementById('stripeContent')) {
    return;
  }

  stripeCount = needed;
  stripes.innerHTML = `<div id="stripeContent">${Array.from({ length: stripeCount }, () => '<div class="stripe-line"></div>').join('')}</div>`;
  renderStripeMarkers();
}

function getEditorPaddingTop(): number {
  return parseFloat(getComputedStyle(source).paddingTop) || 0;
}

function getEditorPaddingLeft(): number {
  return parseFloat(getComputedStyle(source).paddingLeft) || 0;
}

function getCharacterWidth(): number {
  if (characterWidth) {
    return characterWidth;
  }

  const probe = document.createElement('span');
  const style = getComputedStyle(source);
  probe.textContent = 'M';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.fontFamily = style.fontFamily;
  probe.style.fontSize = style.fontSize;
  probe.style.fontWeight = style.fontWeight;
  probe.style.lineHeight = style.lineHeight;
  document.body.appendChild(probe);
  characterWidth = probe.getBoundingClientRect().width || 8;
  probe.remove();
  return characterWidth;
}

function setDiagnosticLines(lines: unknown): void {
  diagnosticLines = Array.isArray(lines)
    ? [...new Set((lines as number[]).filter((line) => Number.isInteger(line) && line > 0))].sort((left, right) => left - right)
    : [];
  renderErrorLines();
}

function clearDiagnosticLines(): void {
  if (diagnosticLines.length === 0) {
    return;
  }

  diagnosticLines = [];
  renderErrorLines();
}

function renderErrorLines(): void {
  renderStripeMarkers();
}

function renderStripeMarkers(): void {
  const hasSelection = source.selectionStart !== source.selectionEnd;
  if (activeLineIndex === stripeActiveLineIndex && hasSelection === stripeHasSelection && diagnosticLines.length === stripeErrorCount) {
    return;
  }
  stripeActiveLineIndex = activeLineIndex;
  stripeHasSelection = hasSelection;
  stripeErrorCount = diagnosticLines.length;

  const stripeLines = document.getElementById('stripeContent')?.children;
  if (!stripeLines) {
    return;
  }

  const errorLineIndexes = new Set(diagnosticLines.map((line) => line - 1));
  Array.from(stripeLines).forEach((line, index) => {
    line.classList.toggle('is-active', !hasSelection && index === activeLineIndex);
    line.classList.toggle('has-error', errorLineIndexes.has(index));
  });
}

function generateNow(): void {
  clearDiagnosticLines();
  vscode.postMessage({ type: 'generate', text: source.value });
}

function applyFormattedSource(text = source.value): void {
  const edit = formatCgenWithCursor(text, source.selectionStart);
  if (edit.text === source.value) {
    return;
  }
  source.value = edit.text;
  source.selectionStart = edit.cursor;
  source.selectionEnd = edit.cursor;
  clearSuggestion();
  paint();
  queueChangeMessage();
}

function queueChangeMessage(): void {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => vscode.postMessage({
    type: 'change',
    text: source.value,
    cursor: source.selectionStart,
    scrollTop: source.scrollTop
  }), 500);
}

function syncScroll(): void {
  syncMetrics(false);
  highlight.scrollTop = source.scrollTop;
  highlight.scrollLeft = source.scrollLeft;
  suggestion.scrollTop = source.scrollTop;
  suggestion.scrollLeft = source.scrollLeft;
  lineNumbers.scrollTop = source.scrollTop;
  ensureStripeCount();
  renderErrorLines();
  const stripeContent = document.getElementById('stripeContent');
  if (stripeContent) {
    stripeContent.style.transform = `translateY(${-source.scrollTop}px)`;
  }
  updateActiveLine();
  lineAttachments.render();
}

function updateBreadcrumb(): void {
  const lineStart = getLineStart(source.selectionStart);
  const currentLinePrefix = source.value.slice(lineStart, source.selectionStart);
  const currentIndent = currentLinePrefix.match(/^ */)?.[0].length ?? 0;
  const lines = source.value.slice(0, lineStart).split('\n');
  const stack: Array<{ indent: number; name: string }> = [];
  for (const line of lines) {
    const match = line.match(/^( *)(package|module|scope)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
    if (!match) { continue; }
    const indent = match[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) { stack.pop(); }
    stack.push({ indent, name: match[3] });
  }

  while (stack.length > 0 && stack[stack.length - 1].indent >= currentIndent) {
    stack.pop();
  }

  const currentSection = currentLinePrefix.match(/^( *)(package|module|scope)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
  if (currentSection) {
    const indent = currentSection[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) { stack.pop(); }
    stack.push({ indent, name: currentSection[3] });
  }

  breadcrumb.textContent = stack.map((item) => item.name).join(' › ');
}

function updateActiveLine(): void {
  const textBeforeCaret = source.value.slice(0, source.selectionStart);
  const previousActiveLineIndex = activeLineIndex;
  activeLineIndex = textBeforeCaret.split('\n').length - 1;
  renderStripeMarkers();
  if (previousActiveLineIndex !== activeLineIndex) {
    lineNumbers.innerHTML = renderLineNumbers(Math.max(1, source.value.split('\n').length));
  }
}

function updateSelectionMode(): void {
  source.closest('.editor')!.classList.toggle('has-selection', source.selectionStart !== source.selectionEnd);
  if (source.selectionStart !== source.selectionEnd) {
    clearSuggestion();
  }
  paintHighlight();
}

function clearSuggestion(): void {
  const hadSuggestion = !!suggestionInsertText;
  clearTimeout(suggestTimer);
  suggestRequestId += 1;
  suggestionInsertText = '';
  suggestionReplaceLeft = 0;
  completionCandidates = [];
  completionInsertTexts = [];
  completionCandidateKinds = [];
  completionIndex = 0;
  completionContextKey = '';
  completionPrefix = '';
  completionList.hidden = true;
  if (hadSuggestion && scheduledPaintId === undefined) {
    paintHighlight();
  }
}

function getCursorPixelPos(): { x: number; y: number } {
  const cursor = source.selectionStart;
  const text = source.value.slice(0, cursor);
  const lines = text.split('\n');
  const row = lines.length - 1;
  const col = lines[row].length;
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
  const x = col * getCharacterWidth() + getEditorPaddingLeft() - source.scrollLeft;
  const y = (row + 1) * lineHeight + getEditorPaddingTop() - source.scrollTop;
  return { x, y };
}

function completionIconFor(kind: string): [string, string] {
  switch (kind) {
    case 'keyword': return ['symbol-keyword', 'keyword'];
    case 'package':
    case 'module':
    case 'scope': return ['symbol-module', 'module'];
    case 'alias': return ['symbol-interface', 'interface'];
    case 'enum': return ['symbol-enum', 'enum'];
    case 'case': return ['symbol-enum-member', 'enum'];
    case 'struct': return ['symbol-struct', 'struct'];
    case 'template':
    case 'fn': return ['symbol-method', 'method'];
    case 'field': return ['symbol-field', 'variable'];
    case 'param': return ['symbol-variable', 'variable'];
    default: return ['symbol-struct', 'struct'];
  }
}

function completionGroupFor(kind: string): string {
  switch (kind) {
    case 'keyword':
    case 'param':
    case 'field':
      return 'Keywords';
    case 'alias':
    case 'enum':
    case 'struct':
      return 'Types';
    case 'package':
    case 'module':
    case 'scope':
      return 'Sections';
    case 'template':
    case 'fn':
      return 'Callables';
    default:
      return 'Symbols';
  }
}

function renderCompletionList(): void {
  let previousGroup = '';
  completionList.innerHTML = completionCandidates.map((label, i) => {
    const [iconClass, colorClass] = completionIconFor(completionCandidateKinds[i] ?? '');
    const group = completionGroupFor(completionCandidateKinds[i] ?? '');
    const header = group !== previousGroup
      ? `<div class="completion-group" aria-hidden="true">${group}</div>`
      : '';
    previousGroup = group;
    return `${header}<div class="completion-item${i === completionIndex ? ' active' : ''}" data-index="${i}">` +
      `<span class="completion-icon-col ci-${colorClass}">` +
      `<i class="codicon codicon-${iconClass}" aria-hidden="true"></i>` +
      `</span>` +
      `<span class="completion-label">${escapeHtml(label.includes(' ') ? label.replace(/:$/, '') : label)}</span>` +
      `</div>`;
  }).join('');
}

function positionCompletionList(): void {
  if (completionList.hidden) {
    return;
  }

  const pos = getCursorPixelPos();
  const editorEl = source.closest('.editor')!;
  const editorHeight = (editorEl as HTMLElement).clientHeight;
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
  const listHeight = completionList.offsetHeight;
  const gap = 6;
  const lineTop = pos.y - lineHeight;
  const lineBottom = pos.y;
  const spaceBelow = editorHeight - lineBottom - gap;
  const spaceAbove = lineTop - gap;

  const top = spaceBelow >= listHeight
    ? lineBottom + gap
    : Math.max(gap, lineTop - gap - Math.min(listHeight, Math.max(spaceAbove, 0)));
  completionList.style.top = `${top}px`;
  completionList.style.left = `${pos.x}px`;
}

function showCompletionList(candidates: string[], insertTexts: string[], kinds: string[], contextKey: string, prefix: string): void {
  if (!candidates.length) {
    completionList.hidden = true;
    return;
  }
  completionCandidates = candidates;
  completionInsertTexts = insertTexts;
  completionCandidateKinds = kinds;
  completionIndex = 0;
  completionContextKey = contextKey;
  completionPrefix = prefix;
  renderCompletionList();

  completionList.style.top = '-9999px';
  completionList.style.left = '-9999px';
  completionList.hidden = false;
  positionCompletionList();
}

function selectCompletionItem(index: number): void {
  completionIndex = Math.max(0, Math.min(index, completionCandidates.length - 1));
  suggestionInsertText = completionInsertTexts[completionIndex] ?? '';
  renderCompletionList();
  completionList.querySelectorAll('.completion-item')[completionIndex]?.scrollIntoView({ block: 'nearest' });
  paintHighlight();
}

function paintHighlight(): void {
  const lines = source.value.split('\n');
  const hasSelection = source.selectionStart !== source.selectionEnd;
  const hasGhost = !!(suggestionInsertText && source.selectionStart === source.selectionEnd);

  syncLineCache(lines);

  const highlighted = hasSelection
    ? highlightLinesWithSelection(lines)
    : navHoverRange
    ? highlightNavigationRange(lines)
    : hasGhost
      ? highlightLinesWithGhost(lines)
      : snippetEngine.active
        ? snippetEngine.highlightTabStops(lines, source.selectionEnd, source.value, highlightLine, escapeHtml)
        : cachedLineHTMLs.join('\n');
  highlight.innerHTML = `${highlighted || ' '}${scrollTail()}`;
}

function syncLineCache(lines: string[]): void {
  const newCount = lines.length;
  const oldCount = cachedRawLines.length;

  if (newCount !== oldCount) {
    cachedRawLines = lines.slice();
    cachedLineHTMLs = lines.map(highlightLine);
    return;
  }

  for (let i = 0; i < newCount; i++) {
    if (lines[i] !== cachedRawLines[i]) {
      cachedRawLines[i] = lines[i];
      cachedLineHTMLs[i] = highlightLine(lines[i]);
    }
  }
}

function renderSuggestion(): void {
  if (suggestionInsertText && source.selectionStart === source.selectionEnd) {
    paintHighlight();
  }
}

function renderSuggestionNow(): void {
  renderSuggestion();
  syncScroll();
}

function requestSuggestion(): void {
  clearTimeout(suggestTimer);
  if (source.selectionStart !== source.selectionEnd) {
    clearSuggestion();
    return;
  }

  suggestionInsertText = (!isDeletingKey && popupAllowed) ? getLocalSuggestion() : '';
  renderSuggestion();

  suggestTimer = setTimeout(() => {
    const id = ++suggestRequestId;
    vscode.postMessage({
      type: 'suggest',
      id,
      text: source.value,
      cursor: source.selectionStart
    });
  }, 120);
}

function getLocalSuggestion(): string {
  const cursor = source.selectionStart;
  const lineStart = source.value.lastIndexOf('\n', cursor - 1) + 1;
  const lineEnd = source.value.indexOf('\n', cursor);
  const beforeCursor = source.value.slice(lineStart, cursor);
  const afterCursor = source.value.slice(cursor, lineEnd === -1 ? source.value.length : lineEnd);
  if (beforeCursor.trim().length === 0 || afterCursor.trim().length > 0) {
    return '';
  }

  const typed = beforeCursor.trimStart();
  const pool = (contextCandidates[lastContextKey] as string[] | undefined) ?? lastContextCandidates;
  const candidate = pool.find((value) => value.startsWith(typed));
  if (!candidate) { return ''; }
  const insert = candidate.slice(typed.length);
  return source.value.startsWith(insert, cursor) ? '' : insert;
}

function acceptSuggestion(): boolean {
  if (!suggestionInsertText || source.selectionStart !== source.selectionEnd) {
    return false;
  }

  const acceptedIndex = completionList.hidden ? Math.max(0, completionIndex) : completionIndex;
  const acceptedLabel = completionCandidates[acceptedIndex] ?? '';
  const acceptedKind = completionCandidateKinds[acceptedIndex] ?? '';
  const acceptedContextKey = completionContextKey;
  const acceptedPrefix = completionPrefix;
  let insertText = suggestionInsertText;
  if (insertText.endsWith(':') && source.value[source.selectionEnd] === ':') {
    insertText = insertText.slice(0, -1);
  }

  if (suggestionReplaceLeft > 0) {
    const pos = source.selectionStart - suggestionReplaceLeft;
    source.value = source.value.slice(0, pos) + source.value.slice(source.selectionStart);
    source.selectionStart = pos;
    source.selectionEnd = pos;
  }

  const paramWords = snippetEngine.extractTabStopWords(insertText);
  if (paramWords.length > 0) {
    snippetEngine.setTabStopWords(paramWords);
  }
  const edit = snippetEngine.getSuggestionEdit(insertText);
  replaceSelection(edit.text, undefined, edit.selection);
  if (acceptedLabel && acceptedContextKey) {
    vscode.postMessage({
      type: 'suggestionAccepted',
      contextKey: acceptedContextKey,
      prefix: acceptedPrefix,
      label: acceptedLabel,
      kind: acceptedKind
    });
  }
  clearSuggestion();
  const wasActive = snippetEngine.active;
  if (edit.tabStops && edit.tabStops.length > 0) {
    snippetEngine.activate(edit);
  }
  if (snippetEngine.active || wasActive) {
    paint();
  }
  requestSuggestion();
  return true;
}

function replaceSelection(text: string, cursorOffset?: number, selection?: { start: number; end: number }): void {
  const start = source.selectionStart;
  const end = source.selectionEnd;
  source.value = `${source.value.slice(0, start)}${text}${source.value.slice(end)}`;
  const cursor = start + (cursorOffset ?? text.length);
  source.selectionStart = start + (selection?.start ?? cursor - start);
  source.selectionEnd = start + (selection?.end ?? cursor - start);
  clearSuggestion();
  schedulePaint();
  updateSelectionMode();
  queueChangeMessage();
}

function getLineStart(position: number): number {
  return source.value.lastIndexOf('\n', position - 1) + 1;
}

function getSelectedLineRange(): { start: number; end: number } {
  const start = getLineStart(source.selectionStart);
  let end = source.selectionEnd;
  if (end > source.selectionStart && source.value[end - 1] === '\n') {
    end -= 1;
  }

  const endLineStart = getLineStart(end);
  const endLineEnd = source.value.indexOf('\n', endLineStart);
  return {
    start,
    end: endLineEnd === -1 ? source.value.length : endLineEnd
  };
}

function indentSelection(): void {
  const selectionStart = source.selectionStart;
  const selectionEnd = source.selectionEnd;

  if (selectionStart === selectionEnd) {
    replaceSelection(indentText);
    return;
  }

  const range = getSelectedLineRange();
  const before = source.value.slice(0, range.start);
  const selected = source.value.slice(range.start, range.end);
  const after = source.value.slice(range.end);
  const indented = selected.replace(/^/gm, indentText);

  source.value = `${before}${indented}${after}`;
  source.selectionStart = selectionStart + indentText.length;
  source.selectionEnd = selectionEnd + (indented.length - selected.length);
  schedulePaint();
  queueChangeMessage();
}

function outdentSelection(): void {
  const selectionStart = source.selectionStart;
  const selectionEnd = source.selectionEnd;
  const range = getSelectedLineRange();
  const before = source.value.slice(0, range.start);
  const selected = source.value.slice(range.start, range.end);
  const after = source.value.slice(range.end);
  let removedBeforeSelection = 0;
  let removedTotal = 0;
  let offset = range.start;

  const outdented = selected.replace(/^( {1,4}|\t)/gm, (match) => {
    if (offset < selectionStart) {
      removedBeforeSelection += match.length;
    }
    removedTotal += match.length;
    offset += match.length;
    return '';
  });

  source.value = `${before}${outdented}${after}`;
  source.selectionStart = Math.max(range.start, selectionStart - removedBeforeSelection);
  source.selectionEnd = Math.max(source.selectionStart, selectionEnd - removedTotal);
  schedulePaint();
  queueChangeMessage();
}

function scrollToCursor(): void {
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
  const paddingTop = getEditorPaddingTop();
  const lineIndex = source.value.slice(0, source.selectionStart).split('\n').length - 1;
  const top = paddingTop + lineIndex * lineHeight;
  const bottom = top + lineHeight;
  if (bottom > source.scrollTop + source.clientHeight) {
    source.scrollTop = bottom - source.clientHeight + paddingTop;
  } else if (top < source.scrollTop) {
    source.scrollTop = Math.max(0, top - paddingTop);
  }
}

function getTokenAtPosition(position: number): { token: string; start: number; end: number } | undefined {
  const left = source.value.slice(0, position).match(/[A-Za-z_][A-Za-z0-9_.]*$/)?.[0] ?? '';
  const right = source.value.slice(position).match(/^[A-Za-z0-9_.]*/)?.[0] ?? '';
  const token = `${left}${right}`.replace(/^\.+|\.+$/g, '');
  if (!token || token.startsWith('c.')) {
    return undefined;
  }

  return {
    token,
    start: position - left.length,
    end: position + right.length
  };
}

function getTokenAtCursor(): { token: string; start: number; end: number } | undefined {
  return getTokenAtPosition(source.selectionStart);
}

function getPositionFromPointer(event: MouseEvent): number | undefined {
  const rect = source.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
  const x = event.clientX - rect.left - getEditorPaddingLeft() + source.scrollLeft;
  const y = event.clientY - rect.top - getEditorPaddingTop() + source.scrollTop;
  const lineIndex = Math.floor(y / lineHeight);
  const lines = source.value.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length || x < 0) {
    return undefined;
  }

  const column = Math.min(lines[lineIndex].length, Math.max(0, Math.floor(x / getCharacterWidth())));
  return lines.slice(0, lineIndex).reduce((offset, line) => offset + line.length + 1, 0) + column;
}

function buildDeclarationIndex(): Array<{ name: string; path: string[]; position: number }> {
  const declarations: Array<{ name: string; path: string[]; position: number }> = [];
  const stack: Array<{ indent: number; name: string }> = [];
  let offset = 0;

  for (const rawLine of source.value.split('\n')) {
    const withoutComment = rawLine.replace(/#.*$/, '').trimEnd();
    const trimmed = withoutComment.trim();
    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;

    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const section = trimmed.match(/^(package|module|scope)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (section) {
      const path = [...stack.map((item) => item.name), section[2]];
      declarations.push({ name: section[2], path, position: offset + rawLine.indexOf(section[2]) });
      stack.push({ indent, name: section[2] });
      offset += rawLine.length + 1;
      continue;
    }

    const symbol = trimmed.match(/^(alias|enum|template|fn)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (symbol) {
      const path = [...stack.map((item) => item.name), symbol[2]];
      declarations.push({ name: symbol[2], path, position: offset + rawLine.indexOf(symbol[2]) });
    }

    offset += rawLine.length + 1;
  }

  return declarations;
}

function publicPath(path: string[]): string[] {
  const parts = [...path];
  if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
    parts.pop();
  }

  return parts;
}

function findDeclaration(token: string): number | undefined {
  const parts = token.split('.').filter(Boolean);
  const name = parts[parts.length - 1];
  if (!name || parts[0] === 'c') {
    return undefined;
  }

  const declarations = buildDeclarationIndex().filter((declaration) => declaration.name === name);
  const exact = declarations.find((declaration) => publicPath(declaration.path).join('.') === token);
  const full = exact ?? declarations.find((declaration) => declaration.path.join('.') === token);
  const local = full ?? declarations[0];

  return local?.position;
}

function goToDeclaration(): boolean {
  const tokenInfo = getTokenAtCursor();
  const position = tokenInfo ? findDeclaration(tokenInfo.token) : undefined;
  if (position === undefined) {
    return false;
  }

  source.selectionStart = position;
  source.selectionEnd = position;
  clearSuggestion();
  scrollToCursor();
  paint();
  return true;
}

function updateNavigationHover(event: MouseEvent): void {
  const isNavigation = event.ctrlKey || event.metaKey;
  const previous = navHoverRange;
  if (!isNavigation) {
    navHoverRange = undefined;
  } else {
    const position = getPositionFromPointer(event);
    const tokenInfo = position === undefined ? undefined : getTokenAtPosition(position);
    navHoverRange = tokenInfo && findDeclaration(tokenInfo.token) !== undefined
      ? { start: tokenInfo.start, end: tokenInfo.end }
      : undefined;
  }

  source.closest('.editor')!.classList.toggle('has-nav-hover', navHoverRange !== undefined);
  if (previous?.start !== navHoverRange?.start || previous?.end !== navHoverRange?.end) {
    paint();
  }
}

function clearNavigationHover(): void {
  if (!navHoverRange) {
    return;
  }

  navHoverRange = undefined;
  source.closest('.editor')!.classList.remove('has-nav-hover');
  paint();
}

function insertIndentedNewline(): void {
  const lineStart = getLineStart(source.selectionStart);
  const linePrefix = source.value.slice(lineStart, source.selectionStart);
  const currentIndent = linePrefix.match(/^\s*/)![0];
  const extraIndent = linePrefix.trimEnd().endsWith(':') ? indentText : '';
  replaceSelection(`\n${currentIndent}${extraIndent}`);
  scrollToCursor();
}

function smartBackspace(): boolean {
  if (source.selectionStart !== source.selectionEnd) {
    return false;
  }

  const cursor = source.selectionStart;
  const lineStart = getLineStart(cursor);
  const beforeCursor = source.value.slice(lineStart, cursor);

  if (!/^\s+$/.test(beforeCursor)) {
    return false;
  }

  const currentIndent = beforeCursor.length;
  const targetIndent = Math.max(0, currentIndent - (currentIndent % indentText.length || indentText.length));
  source.value = `${source.value.slice(0, lineStart + targetIndent)}${source.value.slice(cursor)}`;
  source.selectionStart = lineStart + targetIndent;
  source.selectionEnd = lineStart + targetIndent;
  schedulePaint();
  queueChangeMessage();
  return true;
}

source.addEventListener('input', () => {
  clearDiagnosticLines();
  clearSuggestion();
  schedulePaint();
  popupAllowed = true;
  requestSuggestion();
  queueChangeMessage();
});
source.addEventListener('paste', () => {
  if (!formatPolicy.formatOnPaste) {
    return;
  }
  setTimeout(() => applyFormattedSource(), 0);
});
source.addEventListener('click', (event) => {
  if ((event.ctrlKey || event.metaKey) && goToDeclaration()) {
    return;
  }

  snippetEngine.clear();
  popupAllowed = false;
  clearSuggestion();
  updateSelectionMode();
  updateActiveLine();
  updateBreadcrumb();
  requestSuggestion();
});
source.addEventListener('mousemove', updateNavigationHover);
source.addEventListener('mouseleave', () => {
  clearNavigationHover();
});
source.addEventListener('keyup', (event) => {
  clearNavigationHover();
  updateSelectionMode();
  updateActiveLine();
  updateBreadcrumb();
  if (event.key === 'Escape') {
    return;
  }
  if (!completionList.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    return;
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    isDeletingKey = false;
  }
  requestSuggestion();
});
source.addEventListener('select', () => {
  updateSelectionMode();
  updateActiveLine();
  updateBreadcrumb();
  requestSuggestion();
});
document.addEventListener('selectionchange', () => {
  if (document.activeElement === source) {
    updateSelectionMode();
    updateActiveLine();
  }
});
source.addEventListener('scroll', syncScroll);
source.addEventListener('keydown', (event) => {
  if (event.key === 'Backspace' || event.key === 'Delete') {
    isDeletingKey = true;
  }

  if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.code === 'NumpadEnter')) {
    event.preventDefault();
    generateNow();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && (event.key === ' ' || event.code === 'Space')) {
    event.preventDefault();
    popupAllowed = true;
    requestSuggestion();
    return;
  }

  if (event.key === 'ArrowDown' && !completionList.hidden) {
    event.preventDefault();
    selectCompletionItem(completionIndex + 1);
    return;
  }

  if (event.key === 'ArrowUp' && !completionList.hidden) {
    event.preventDefault();
    selectCompletionItem(completionIndex - 1);
    return;
  }

  if (event.key === 'Tab') {
    event.preventDefault();
    const wasSnippet = snippetEngine.active;
    if (!event.shiftKey && (acceptSuggestion() || snippetEngine.advanceToNextTabStop(source))) {
      paint();
      return;
    }
    if (wasSnippet) {
      const afterSel = source.selectionEnd;
      const lineEnd = source.value.indexOf('\n', afterSel);
      const slice = source.value.slice(afterSel, lineEnd === -1 ? source.value.length : lineEnd);
      const termMatch = slice.match(/[):]/);
      const target = termMatch ? afterSel + termMatch.index! + 1 : afterSel;
      source.selectionStart = target;
      source.selectionEnd = target;
      paint();
      return;
    }

    if (event.shiftKey) {
      outdentSelection();
    } else {
      indentSelection();
    }
    requestSuggestion();
    return;
  }

  if (event.key === 'Enter' && !completionList.hidden) {
    event.preventDefault();
    acceptSuggestion();
    return;
  }

  if (event.key === 'Enter' && snippetEngine.active) {
    if (source.selectionStart !== source.selectionEnd) {
      event.preventDefault();
      source.selectionStart = source.selectionEnd;
      snippetEngine.clear();
      paint();
      return;
    }
    snippetEngine.clear();
  }

  if (event.key === 'Escape' && (suggestionInsertText || !completionList.hidden || snippetEngine.active)) {
    event.preventDefault();
    popupAllowed = false;
    clearSuggestion();
    snippetEngine.clear();
    paint();
    return;
  }

  if (event.key === 'Backspace' && smartBackspace()) {
    event.preventDefault();
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    insertIndentedNewline();
  }
});
window.addEventListener('keyup', (event) => {
  if (event.key === 'Control' || event.key === 'Meta') {
    clearNavigationHover();
  }
});
window.addEventListener('blur', clearNavigationHover);
generate.addEventListener('click', generateNow);
save.addEventListener('click', () => {
  if (formatPolicy.formatOnSave) {
    applyFormattedSource();
  }
  vscode.postMessage({ type: 'save', text: source.value });
});
load.addEventListener('click', () => vscode.postMessage({ type: 'load' }));
const filename = document.getElementById('filename')!;
const breadcrumb = document.getElementById('breadcrumb')!;
window.addEventListener('message', (event: MessageEvent) => {
  if (event.data.type === 'load') {
    clearDiagnosticLines();
    clearSuggestion();
    source.value = event.data.text;
    paint();
    source.focus();
    requestSuggestion();
  }
  if (event.data.type === 'format') {
    applyFormattedSource(event.data.text || source.value);
  }
  if (event.data.type === 'formatPolicy') {
    formatPolicy = {
      formatOnSave: !!event.data.policy?.formatOnSave,
      formatOnPaste: !!event.data.policy?.formatOnPaste
    };
  }
  if (event.data.type === 'title') {
    filename.textContent = ` — ${event.data.text}`;
  }
  if (event.data.type === 'progress') {
    progressBar.classList.toggle('active', !!event.data.active);
  }
  if (event.data.type === 'lineAttachments') {
    lineAttachments.set(event.data.attachments);
  }
  if (event.data.type === 'suggestion' && event.data.id === suggestRequestId) {
    const serverInsertText: string = event.data.insertText || '';
    const serverReplaceLeft: number = event.data.replaceLeft || 0;
    const candidates: string[] = event.data.candidates || [];
    const candidateKinds: string[] = event.data.candidateKinds || [];
    const contextKey: string = event.data.contextKey || '';
    const prefix: string = event.data.prefix || '';
    lastContextKey = contextKey;
    if (candidates.length > 0) {
      lastContextCandidates = candidates;
    }
    if (popupAllowed && candidates.length > 0 && serverInsertText && !source.value.startsWith(serverInsertText, source.selectionEnd)) {
      suggestionInsertText = serverInsertText;
      suggestionReplaceLeft = serverReplaceLeft;
      if (/\w/.test(serverInsertText)) {
        const tailLen = Math.max(0, candidates[0].length - serverInsertText.length);
        const insertTexts = candidates.map((c) => c.slice(tailLen));
        showCompletionList(candidates, insertTexts, candidateKinds, contextKey, prefix);
      } else {
        completionList.hidden = true;
      }
    } else {
      suggestionInsertText = '';
      suggestionReplaceLeft = 0;
      completionList.hidden = true;
    }
    renderSuggestionNow();
  }
  if (event.data.type === 'error') {
    setDiagnosticLines(event.data.lines);
    if (diagnosticLines.length > 0) {
      const firstLine = diagnosticLines[0];
      const offset = source.value
        .split('\n')
        .slice(0, firstLine - 1)
        .reduce((sum, line) => sum + line.length + 1, 0);
      source.selectionStart = offset;
      source.selectionEnd = offset;
      scrollToCursor();
      paint();
      source.focus();
    }
  }
});
let isExpanded = false;
expand.addEventListener('click', () => {
  isExpanded = !isExpanded;
  document.body.classList.toggle('expanded', isExpanded);
  (document.getElementById('expandIcon') as HTMLElement).textContent = isExpanded ? '□' : '⛶';
  vscode.postMessage({ type: 'expand' });
});

function syncMetrics(syncCursor: boolean): void {
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
  (source.closest('.editor') as HTMLElement).style.setProperty('--cgen-line-height', `${lineHeight}px`);
  characterWidth = undefined;

  if (syncCursor) {
    stripeCount = 0;
    requestAnimationFrame(syncScroll);
  }
}

function handleViewportResize(): void {
  syncMetrics(true);
  renderSuggestion();
  requestAnimationFrame(() => {
    syncScroll();
    positionCompletionList();
  });
}

source.closest('.editor')!.appendChild(completionList);

completionList.addEventListener('mousedown', (event) => {
  const item = (event.target as Element).closest('.completion-item') as HTMLElement | null;
  if (!item) { return; }
  event.preventDefault();
  selectCompletionItem(parseInt(item.dataset['index']!, 10));
  acceptSuggestion();
  source.focus();
});

syncMetrics(true);
window.addEventListener('resize', handleViewportResize);
window.visualViewport?.addEventListener('resize', handleViewportResize);

if (window.__cgenCursor > 0) {
  const pos = Math.min(window.__cgenCursor, source.value.length);
  source.selectionStart = pos;
  source.selectionEnd = pos;
  source.scrollTop = window.__cgenScroll || 0;
}
paint();
syncScroll();
requestSuggestion();
source.focus();
