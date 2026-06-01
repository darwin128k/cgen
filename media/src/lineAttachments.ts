export type LineAttachmentKind = 'button' | 'text' | 'object';

export type LineAttachment = {
  id: string;
  line: number;
  kind: LineAttachmentKind;
  label?: string;
  text?: string;
  title?: string;
  action?: string;
  data?: unknown;
};

type LineAttachmentAction = {
  id?: string;
  line: number;
  action?: string;
  data?: unknown;
};

type LineAttachmentControllerOptions = {
  source: HTMLTextAreaElement;
  layer: HTMLElement;
  getEditorPaddingTop(): number;
  onAction(action: LineAttachmentAction): void;
};

export class LineAttachmentController {
  private attachments: LineAttachment[] = [];

  constructor(private readonly options: LineAttachmentControllerOptions) {
    this.options.layer.addEventListener('mousedown', (event) => this.handleMouseDown(event));
  }

  set(value: unknown): void {
    this.attachments = Array.isArray(value) ? value.filter(isLineAttachment) : [];
    this.options.source.closest('.editor')!.classList.toggle('has-line-attachments', this.attachments.length > 0);
    this.render();
  }

  render(): void {
    if (this.attachments.length === 0) {
      this.options.layer.replaceChildren();
      return;
    }

    const source = this.options.source;
    const lineCount = Math.max(1, source.value.split('\n').length);
    const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
    const paddingTop = this.options.getEditorPaddingTop();
    const fragment = document.createDocumentFragment();

    for (const attachment of this.attachments) {
      if (attachment.line > lineCount) {
        continue;
      }

      const item = document.createElement(attachment.kind === 'button' ? 'button' : 'span');
      item.className = `line-attachment line-attachment-${attachment.kind}`;
      item.dataset['id'] = attachment.id;
      item.dataset['line'] = String(attachment.line);
      item.style.top = `${paddingTop + (attachment.line - 1) * lineHeight - source.scrollTop}px`;
      item.style.minHeight = `${lineHeight}px`;
      item.title = attachment.title || '';

      if (attachment.kind === 'button') {
        (item as HTMLButtonElement).type = 'button';
        item.textContent = attachment.label || attachment.text || attachment.action || attachment.id;
        item.dataset['action'] = attachment.action || attachment.id;
      } else if (attachment.kind === 'object') {
        item.textContent = attachment.label || formatAttachmentData(attachment.data);
      } else {
        item.textContent = attachment.text || attachment.label || '';
      }

      fragment.appendChild(item);
    }

    this.options.layer.replaceChildren(fragment);
  }

  private handleMouseDown(event: MouseEvent): void {
    const item = (event.target as Element).closest('.line-attachment-button') as HTMLElement | null;
    if (!item) { return; }

    event.preventDefault();
    event.stopPropagation();

    this.options.onAction({
      id: item.dataset['id'],
      line: Number(item.dataset['line']),
      action: item.dataset['action'],
      data: this.attachments.find((attachment) => attachment.id === item.dataset['id'])?.data
    });
    this.options.source.focus();
  }
}

function isLineAttachment(value: unknown): value is LineAttachment {
  const item = value as Partial<LineAttachment>;
  return !!item
    && typeof item.id === 'string'
    && Number.isInteger(item.line)
    && item.line > 0
    && (item.kind === 'button' || item.kind === 'text' || item.kind === 'object');
}

function formatAttachmentData(data: unknown): string {
  if (data === undefined || data === null) {
    return '{}';
  }

  if (typeof data === 'string') {
    return data;
  }

  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
