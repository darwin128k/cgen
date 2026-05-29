(function () {
  const vscode = acquireVsCodeApi();
  const source = document.getElementById('source');
  const highlight = document.getElementById('highlight');
  const suggestion = document.getElementById('suggestion');
  const lineNumbers = document.getElementById('lineNumbers');
  const stripes = document.getElementById('stripes');
  const errorLines = document.getElementById('errorLines');
  const activeLine = document.getElementById('activeLine');
  const generate = document.getElementById('generate');
  const save = document.getElementById('save');
  const load = document.getElementById('load');
  const expand = document.getElementById('expand');
  let autoSaveTimer;
  let suggestTimer;
  let suggestRequestId = 0;
  let suggestionInsertText = '';
  let snippetMode = false;
  let snippetTabStopWords = [];
  let navHoverRange;
  let completionCandidates = [];
  let completionInsertTexts = [];
  let completionIndex = 0;

  const completionList = document.createElement('div');
  completionList.id = 'completionList';
  completionList.className = 'completion-list';
  completionList.hidden = true;
  let characterWidth;
  let diagnosticLines = [];
  let activeLineIndex = 0;
  const indentText = '    ';
  const localSuggestionCandidates = [
    '@emit(header)',
    '@emit(source)',
    '@emit(both)',
    '@enum(static)',
    '@enum(define)',
    '@enum(extern)',
    'package name:',
    'module name:',
    'scope name:',
    'alias name as type',
    'enum name as type:',
    'alias ptr as c.ptr.of()',
    'case name',
    'template name:',
    'param name',
    'param ... as values',
    'field name as type',
    'use c.ptr(value)'
  ];
  let stripeCount = 0;

  function escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function highlightToken(token) {
    if (/^#.*$/.test(token)) {
      return `<span class="comment">${escapeHtml(token)}</span>`;
    }

    if (/^@[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
      return `<span class="attr">${escapeHtml(token)}</span>`;
    }

    if (/^(package|module|scope|alias|enum|case|as|template|param|field|use)$/.test(token)) {
      return `<span class="kw">${escapeHtml(token)}</span>`;
    }

    if (/^c\./.test(token)) {
      return `<span class="builtin">${escapeHtml(token)}</span>`;
    }

    return escapeHtml(token);
  }

  function highlightLine(line) {
    const commentIndex = line.indexOf('#');
    const rawCode = commentIndex === -1 ? line : line.slice(0, commentIndex);
    const comment = commentIndex === -1 ? '' : line.slice(commentIndex);
    const highlightedCode = escapeHtml(rawCode).replace(
      /(@[A-Za-z_][A-Za-z0-9_]*|\bc\.[A-Za-z_][A-Za-z0-9_.]*\b|\bpackage\b|\bmodule\b|\bscope\b|\balias\b|\benum\b|\bcase\b|\bas\b|\btemplate\b|\bparam\b|\bfield\b|\buse\b)/g,
      highlightToken
    );
    return `${highlightedCode}${comment ? highlightToken(comment) : ''}`;
  }

  function highlightNavigationRange(lines) {
    if (!navHoverRange) {
      return lines.map(highlightLine).join('\n');
    }

    let offset = 0;
    return lines.map((line) => {
      const lineStart = offset;
      const lineEnd = lineStart + line.length;
      offset = lineEnd + 1;

      if (navHoverRange.end <= lineStart || navHoverRange.start >= lineEnd) {
        return highlightLine(line);
      }

      const start = Math.max(0, navHoverRange.start - lineStart);
      const end = Math.min(line.length, navHoverRange.end - lineStart);
      return [
        highlightLine(line.slice(0, start)),
        `<span class="nav-token">${highlightLine(line.slice(start, end))}</span>`,
        highlightLine(line.slice(end))
      ].join('');
    }).join('\n');
  }

  function scrollTail() {
    return '<span class="scroll-tail" aria-hidden="true"></span>';
  }

  function tabStopRegex(global) {
    const words = snippetTabStopWords.length > 0
      ? snippetTabStopWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
      : 'NAME|name|type|value|values';
    return new RegExp(`\\b(${words})\\b`, global ? 'g' : '');
  }

  function highlightSnippetTabStops(lines) {
    const cursor = source.selectionEnd;
    const text = source.value;
    const lineEnd = text.indexOf('\n', cursor);
    const searchEnd = lineEnd === -1 ? text.length : lineEnd;
    const searchRegion = text.slice(cursor, searchEnd);
    const tabStopPositions = [];
    const placeholderRegex = tabStopRegex(true);
    let match;
    while ((match = placeholderRegex.exec(searchRegion)) !== null) {
      tabStopPositions.push({ start: cursor + match.index, end: cursor + match.index + match[0].length });
    }

    if (tabStopPositions.length === 0) {
      return lines.map(highlightLine).join('\n');
    }

    let offset = 0;
    return lines.map((line) => {
      const lineStart = offset;
      offset = lineStart + line.length + 1;
      const lineTabStops = tabStopPositions.filter((ts) => ts.start >= lineStart && ts.end <= lineStart + line.length);
      if (lineTabStops.length === 0) {
        return highlightLine(line);
      }
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

  function highlightLinesWithGhost(lines) {
    const cursor = source.selectionStart;
    const linesBefore = source.value.slice(0, cursor).split('\n');
    const cursorLineIndex = linesBefore.length - 1;
    const cursorCol = linesBefore[cursorLineIndex].length;
    return lines.map((line, i) => {
      if (i !== cursorLineIndex) {
        return highlightLine(line);
      }
      const before = line.slice(0, cursorCol);
      const after = line.slice(cursorCol);
      return `${highlightLine(before)}<span class="ghost-text">${escapeHtml(suggestionInsertText)}</span>${highlightLine(after)}`;
    }).join('\n');
  }

  function paint() {
    syncMetrics(false);
    paintHighlight();
    suggestion.textContent = '';

    const lineCount = Math.max(1, source.value.split('\n').length);
    lineNumbers.textContent = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n');
    ensureStripeCount();
    renderErrorLines();
    updateSelectionMode();
    updateActiveLine();
    updateBreadcrumb();
    syncScroll();
    requestAnimationFrame(syncScroll);
  }

  function ensureStripeCount() {
    const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
    const needed = Math.ceil((source.scrollTop + source.clientHeight) / lineHeight) + 24;
    if (needed <= stripeCount && document.getElementById('stripeContent')) {
      return;
    }

    stripeCount = needed;
    stripes.innerHTML = `<div id="stripeContent">${Array.from({ length: stripeCount }, () => '<div class="stripe-line"></div>').join('')}</div>`;
    renderStripeMarkers();
  }

  function getEditorPaddingTop() {
    return parseFloat(getComputedStyle(source).paddingTop) || 0;
  }

  function getEditorPaddingLeft() {
    return parseFloat(getComputedStyle(source).paddingLeft) || 0;
  }

  function getCharacterWidth() {
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

  function setDiagnosticLines(lines) {
    diagnosticLines = Array.isArray(lines)
      ? [...new Set(lines.filter((line) => Number.isInteger(line) && line > 0))].sort((left, right) => left - right)
      : [];
    renderErrorLines();
  }

  function clearDiagnosticLines() {
    if (diagnosticLines.length === 0) {
      return;
    }

    diagnosticLines = [];
    renderErrorLines();
  }

  function renderErrorLines() {
    renderStripeMarkers();
  }

  function renderStripeMarkers() {
    const stripeLines = document.getElementById('stripeContent')?.children;
    if (!stripeLines) {
      return;
    }

    const errorLineIndexes = new Set(diagnosticLines.map((line) => line - 1));
    Array.from(stripeLines).forEach((line, index) => {
      line.classList.toggle('is-active', index === activeLineIndex);
      line.classList.toggle('has-error', errorLineIndexes.has(index));
    });
  }

  function generateNow() {
    clearDiagnosticLines();
    vscode.postMessage({ type: 'generate', text: source.value });
  }

  function queueChangeMessage() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => vscode.postMessage({
      type: 'change',
      text: source.value,
      cursor: source.selectionStart,
      scrollTop: source.scrollTop
    }), 500);
  }

  function syncScroll() {
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
  }

  function updateBreadcrumb() {
    const lineStart = getLineStart(source.selectionStart);
    const currentLinePrefix = source.value.slice(lineStart, source.selectionStart);
    const currentIndent = currentLinePrefix.match(/^ */)?.[0].length ?? 0;
    const lines = source.value.slice(0, lineStart).split('\n');
    const stack = [];
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

  function updateActiveLine() {
    const textBeforeCaret = source.value.slice(0, source.selectionStart);
    activeLineIndex = textBeforeCaret.split('\n').length - 1;
    renderStripeMarkers();
  }

  function updateSelectionMode() {
    source.closest('.editor').classList.toggle('has-selection', source.selectionStart !== source.selectionEnd);
    if (source.selectionStart !== source.selectionEnd) {
      clearSuggestion();
    }
  }

  function clearSuggestion() {
    const hadSuggestion = !!suggestionInsertText;
    clearTimeout(suggestTimer);
    suggestRequestId += 1;
    suggestionInsertText = '';
    completionCandidates = [];
    completionInsertTexts = [];
    completionIndex = 0;
    completionList.hidden = true;
    if (hadSuggestion) {
      paintHighlight();
    }
  }

  function getCursorPixelPos() {
    const cursor = source.selectionStart;
    const text = source.value.slice(0, cursor);
    const lines = text.split('\n');
    const row = lines.length - 1;
    const col = lines[row].length;
    const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
    const x = col * (characterWidth || 7.2) + getEditorPaddingLeft() - source.scrollLeft;
    const y = (row + 1) * lineHeight + getEditorPaddingTop() - source.scrollTop;
    return { x, y };
  }

  function completionIconFor(label) {
    if (/^@/.test(label)) return ['symbol-keyword', 'keyword'];
    if (/^(package|module|scope)\b/.test(label)) return ['symbol-module', 'module'];
    if (/^alias\b/.test(label)) return ['symbol-interface', 'interface'];
    if (/^enum\b/.test(label)) return ['symbol-enum', 'enum'];
    if (/^case\b/.test(label)) return ['symbol-enum-member', 'enum'];
    if (/^template\b/.test(label)) return ['symbol-function', 'function'];
    if (/^param\b/.test(label)) return ['symbol-variable', 'variable'];
    if (/^field\b/.test(label)) return ['symbol-field', 'variable'];
    if (/\(\)/.test(label)) return ['symbol-method', 'method'];
    return ['symbol-struct', 'struct'];
  }

  function renderCompletionList() {
    completionList.innerHTML = completionCandidates.map((label, i) => {
      const [iconClass, colorClass] = completionIconFor(label);
      return `<div class="completion-item${i === completionIndex ? ' active' : ''}" data-index="${i}">` +
        `<span class="completion-icon-col ci-${colorClass}">` +
        `<i class="codicon codicon-${iconClass}" aria-hidden="true"></i>` +
        `</span>` +
        `<span class="completion-label">${escapeHtml(label.replace(/:$/, ''))}</span>` +
        `</div>`;
    }).join('');
  }

  function showCompletionList(candidates, insertTexts) {
    if (!candidates.length) {
      completionList.hidden = true;
      return;
    }
    completionCandidates = candidates;
    completionInsertTexts = insertTexts;
    completionIndex = 0;
    renderCompletionList();

    completionList.style.top = '-9999px';
    completionList.style.left = '-9999px';
    completionList.hidden = false;

    const pos = getCursorPixelPos();
    const editorEl = source.closest('.editor');
    const editorHeight = editorEl.clientHeight;
    const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
    const listHeight = completionList.offsetHeight;
    const spaceBelow = editorHeight - pos.y;

    const top = spaceBelow >= listHeight + 4 ? pos.y : pos.y - lineHeight - listHeight;
    completionList.style.top = `${top}px`;
    completionList.style.left = `${pos.x}px`;
  }

  function selectCompletionItem(index) {
    completionIndex = Math.max(0, Math.min(index, completionCandidates.length - 1));
    suggestionInsertText = completionInsertTexts[completionIndex] ?? '';
    renderCompletionList();
    paintHighlight();
  }

  function paintHighlight() {
    const lines = source.value.split('\n');
    const hasGhost = suggestionInsertText && source.selectionStart === source.selectionEnd;
    const highlighted = navHoverRange
      ? highlightNavigationRange(lines)
      : hasGhost
        ? highlightLinesWithGhost(lines)
        : snippetMode
          ? highlightSnippetTabStops(lines)
          : lines.map(highlightLine).join('\n');
    highlight.innerHTML = `${highlighted || ' '}${scrollTail()}`;
  }

  function renderSuggestion() {
    if (suggestionInsertText && source.selectionStart === source.selectionEnd) {
      paintHighlight();
    }
  }

  function renderSuggestionNow() {
    renderSuggestion();
    syncScroll();
  }

  function requestSuggestion() {
    clearTimeout(suggestTimer);
    if (source.selectionStart !== source.selectionEnd) {
      clearSuggestion();
      return;
    }

    suggestionInsertText = getLocalSuggestion();
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

  function getLocalSuggestion() {
    const cursor = source.selectionStart;
    const lineStart = source.value.lastIndexOf('\n', cursor - 1) + 1;
    const lineEnd = source.value.indexOf('\n', cursor);
    const beforeCursor = source.value.slice(lineStart, cursor);
    const afterCursor = source.value.slice(cursor, lineEnd === -1 ? source.value.length : lineEnd);
    if (beforeCursor.trim().length === 0 || afterCursor.trim().length > 0) {
      return '';
    }

    const typed = beforeCursor.trimStart();
    const candidate = localSuggestionCandidates.find((value) => value.startsWith(typed));
    return candidate ? candidate.slice(typed.length) : '';
  }

  function extractTabStopWords(text) {
    const match = text.match(/\(([^()]*)\)/);
    if (!match) { return []; }
    return match[1].split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
  }

  function acceptSuggestion() {
    if (!suggestionInsertText || source.selectionStart !== source.selectionEnd) {
      return false;
    }

    const paramWords = extractTabStopWords(suggestionInsertText);
    snippetTabStopWords = paramWords.length > 0 ? paramWords : [];
    const edit = getSuggestionEdit(suggestionInsertText);
    replaceSelection(edit.text, undefined, edit.selection);
    clearSuggestion();
    snippetMode = edit.tabStops !== undefined && edit.tabStops.length >= 1;
    if (!snippetMode) {
      snippetTabStopWords = [];
    }
    if (snippetMode) {
      paint();
    }
    requestSuggestion();
    return true;
  }

  function advanceToNextTabStop() {
    if (!snippetMode) {
      return false;
    }
    const cursor = source.selectionEnd;
    const text = source.value;
    const lineEnd = text.indexOf('\n', cursor);
    const searchEnd = lineEnd === -1 ? text.length : lineEnd;
    const match = tabStopRegex().exec(text.slice(cursor, searchEnd));
    if (match && match.index !== undefined) {
      source.selectionStart = cursor + match.index;
      source.selectionEnd = cursor + match.index + match[0].length;
      return true;
    }
    snippetMode = false;
    snippetTabStopWords = [];
    return false;
  }

  function getSuggestionEdit(text) {
    const placeholderRegex = tabStopRegex(true);
    const tabStops = [];
    let match;
    while ((match = placeholderRegex.exec(text)) !== null) {
      tabStops.push({ start: match.index, end: match.index + match[0].length });
    }

    if (tabStops.length > 0) {
      return {
        text,
        selection: { start: tabStops[0].start, end: tabStops[0].end },
        tabStops
      };
    }

    const emptyCall = text.indexOf('()');
    if (emptyCall !== -1) {
      return {
        text,
        selection: {
          start: emptyCall + 1,
          end: emptyCall + 1
        }
      };
    }

    return { text };
  }

  function replaceSelection(text, cursorOffset, selection) {
    const start = source.selectionStart;
    const end = source.selectionEnd;
    source.value = `${source.value.slice(0, start)}${text}${source.value.slice(end)}`;
    const cursor = start + (cursorOffset ?? text.length);
    source.selectionStart = start + (selection?.start ?? cursor - start);
    source.selectionEnd = start + (selection?.end ?? cursor - start);
    clearSuggestion();
    paint();
    updateSelectionMode();
    queueChangeMessage();
  }

  function getLineStart(position) {
    return source.value.lastIndexOf('\n', position - 1) + 1;
  }

  function getSelectedLineRange() {
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

  function indentSelection() {
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
    paint();
    queueChangeMessage();
  }

  function outdentSelection() {
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
    paint();
    queueChangeMessage();
  }

  function scrollToCursor() {
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

  function getTokenAtPosition(position) {
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

  function getTokenAtCursor() {
    return getTokenAtPosition(source.selectionStart);
  }

  function getPositionFromPointer(event) {
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

  function buildDeclarationIndex() {
    const declarations = [];
    const stack = [];
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

      const symbol = trimmed.match(/^(alias|enum|template)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (symbol) {
        const path = [...stack.map((item) => item.name), symbol[2]];
        declarations.push({ name: symbol[2], path, position: offset + rawLine.indexOf(symbol[2]) });
      }

      offset += rawLine.length + 1;
    }

    return declarations;
  }

  function publicPath(path) {
    const parts = [...path];
    if (parts.length >= 2 && parts[parts.length - 1] === parts[parts.length - 2]) {
      parts.pop();
    }

    return parts;
  }

  function findDeclaration(token) {
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

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function goToDeclaration() {
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

  function updateNavigationHover(event) {
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

    source.closest('.editor').classList.toggle('has-nav-hover', navHoverRange !== undefined);
    if (previous?.start !== navHoverRange?.start || previous?.end !== navHoverRange?.end) {
      paint();
    }
  }

  function clearNavigationHover() {
    if (!navHoverRange) {
      return;
    }

    navHoverRange = undefined;
    source.closest('.editor').classList.remove('has-nav-hover');
    paint();
  }

  function insertIndentedNewline() {
    const lineStart = getLineStart(source.selectionStart);
    const linePrefix = source.value.slice(lineStart, source.selectionStart);
    const currentIndent = linePrefix.match(/^\s*/)[0];
    const extraIndent = linePrefix.trimEnd().endsWith(':') ? indentText : '';
    replaceSelection(`\n${currentIndent}${extraIndent}`);
    scrollToCursor();
  }

  function smartBackspace() {
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
    paint();
    queueChangeMessage();
    return true;
  }

  source.addEventListener('input', () => {
    clearDiagnosticLines();
    clearSuggestion();
    paint();
    requestSuggestion();
    queueChangeMessage();
  });
  source.addEventListener('click', (event) => {
    if ((event.ctrlKey || event.metaKey) && goToDeclaration()) {
      return;
    }

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
    }
  });
  source.addEventListener('scroll', syncScroll);
  source.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.code === 'NumpadEnter')) {
      event.preventDefault();
      generateNow();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && (event.key === ' ' || event.code === 'Space')) {
      event.preventDefault();
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
      const wasSnippet = snippetMode;
      if (!event.shiftKey && (acceptSuggestion() || advanceToNextTabStop())) {
        return;
      }
      if (wasSnippet) {
        const afterSel = source.selectionEnd;
        const lineEnd = source.value.indexOf('\n', afterSel);
        const slice = source.value.slice(afterSel, lineEnd === -1 ? source.value.length : lineEnd);
        const termMatch = slice.match(/[):]/);
        const target = termMatch ? afterSel + termMatch.index + 1 : afterSel;
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

    if (event.key === 'Enter' && snippetMode) {
      event.preventDefault();
      source.selectionStart = source.selectionEnd;
      snippetMode = false;
      snippetTabStopWords = [];
      paint();
      return;
    }

    if (event.key === 'Escape' && (suggestionInsertText || snippetMode)) {
      event.preventDefault();
      clearSuggestion();
      snippetMode = false;
      snippetTabStopWords = [];
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
  save.addEventListener('click', () => vscode.postMessage({ type: 'save', text: source.value }));
  load.addEventListener('click', () => vscode.postMessage({ type: 'load' }));
  const filename = document.getElementById('filename');
  const breadcrumb = document.getElementById('breadcrumb');
  window.addEventListener('message', (event) => {
    if (event.data.type === 'load') {
      clearDiagnosticLines();
      clearSuggestion();
      source.value = event.data.text;
      paint();
      source.focus();
      requestSuggestion();
    }
    if (event.data.type === 'title') {
      filename.textContent = ` — ${event.data.text}`;
    }
    if (event.data.type === 'suggestion' && event.data.id === suggestRequestId) {
      const serverInsertText = event.data.insertText || '';
      const candidates = event.data.candidates || [];
      if (candidates.length > 0 && serverInsertText) {
        suggestionInsertText = serverInsertText;
        const tailLen = Math.max(0, candidates[0].length - serverInsertText.length);
        const insertTexts = candidates.map((c) => c.slice(tailLen));
        showCompletionList(candidates, insertTexts);
      } else {
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
    document.getElementById('expandIcon').textContent = isExpanded ? '□' : '⛶';
    vscode.postMessage({ type: 'expand' });
  });

  function syncMetrics(syncCursor) {
    const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
    source.closest('.editor').style.setProperty('--cgen-line-height', `${lineHeight}px`);
    characterWidth = undefined;

    if (syncCursor) {
      stripeCount = 0;
      requestAnimationFrame(syncScroll);
    }
  }

  source.closest('.editor').appendChild(completionList);

  completionList.addEventListener('mousedown', (event) => {
    const item = event.target.closest('.completion-item');
    if (!item) { return; }
    event.preventDefault();
    selectCompletionItem(parseInt(item.dataset.index, 10));
    acceptSuggestion();
    source.focus();
  });

  syncMetrics(true);
  window.addEventListener('resize', () => {
    syncMetrics(true);
  });
  window.visualViewport?.addEventListener('resize', () => syncMetrics(true));

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
}());
