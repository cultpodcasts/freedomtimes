/**
 * Convert agent draft markdown to EmDash Portable Text blocks.
 * Supports headings, paragraphs, *emphasis*, [links](url), images, video ec:block,
 * blockquote (`>` lines), and translation folds (`<details class="translate">` … `</details>`).
 * See docs/WEEKLY_REPORT_WRITING_GUIDE.md § Translation blocks.
 */

export type PortableSpan = {
  _type: 'span';
  text: string;
  marks: string[];
};

export type PortableBlock = {
  _type: 'block';
  style: 'normal' | 'h2' | 'h3' | 'h4' | 'blockquote';
  children: PortableSpan[];
  markDefs?: Array<{ _type: 'link'; _key: string; href: string }>;
};

export type PortableNode =
  | PortableBlock
  | { _type: 'image'; asset: { url: string }; alt: string }
  | { _type: 'video'; url: string }
  | { _type: 'audio'; url: string };

let markKeyCounter = 0;

function nextMarkKey(): string {
  markKeyCounter += 1;
  return `mk${markKeyCounter}`;
}

function normalizeMediaUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname.startsWith('/_emdash/api/media/file/')) {
      return parsed.pathname;
    }
  } catch {
    /* relative or invalid */
  }
  if (trimmed.startsWith('/_emdash/api/media/file/')) return trimmed;
  return trimmed;
}

function parseInlineSpans(text: string): {
  children: PortableSpan[];
  markDefs: Array<{ _type: 'link'; _key: string; href: string }>;
} {
  const children: PortableSpan[] = [];
  const markDefs: Array<{ _type: 'link'; _key: string; href: string }> = [];
  const pattern = /(\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  const pushPlain = (chunk: string) => {
    if (chunk.length > 0) {
      children.push({ _type: 'span', text: chunk, marks: [] });
    }
  };

  while ((match = pattern.exec(text)) !== null) {
    pushPlain(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('*') && token.endsWith('*')) {
      children.push({
        _type: 'span',
        text: token.slice(1, -1),
        marks: ['em'],
      });
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const key = nextMarkKey();
        markDefs.push({ _type: 'link', _key: key, href: linkMatch[2]!.trim() });
        children.push({ _type: 'span', text: linkMatch[1]!, marks: [key] });
      } else {
        pushPlain(token);
      }
    }
    last = match.index + token.length;
  }
  pushPlain(text.slice(last));
  return { children, markDefs };
}

function textBlock(style: PortableBlock['style'], text: string): PortableBlock {
  const { children, markDefs } = parseInlineSpans(text);
  const block: PortableBlock = { _type: 'block', style, children };
  if (markDefs.length > 0) block.markDefs = markDefs;
  return block;
}

const VIDEO_PATTERN = /^<!--ec:block\s+(\{.*\})\s+-->$/;
const IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const BLOCKQUOTE_PATTERN = /^>\s?(.+)$/;
const TRANSLATE_OPEN_PATTERN = /^<details\s+class="translate">$/i;
const TRANSLATE_CLOSE_PATTERN = /^<\/details>$/i;
const TRANSLATE_SUMMARY_PATTERN = /^<summary>(.+)<\/summary>$/i;

/**
 * @param markdown Body markdown without the leading `# title` line.
 */
export function markdownToPortableText(markdown: string): PortableNode[] {
  markKeyCounter = 0;
  const nodes: PortableNode[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let paragraphBuffer: string[] = [];

  const flushParagraph = () => {
    const text = paragraphBuffer.join(' ').trim();
    paragraphBuffer = [];
    if (text.length > 0) {
      nodes.push(textBlock('normal', text));
    }
  };

  const pushTranslateFold = (summary: string, body: string) => {
    nodes.push(textBlock('normal', '<details class="translate">'));
    nodes.push(textBlock('normal', `<summary>${summary}</summary>`));
    nodes.push(textBlock('normal', body));
    nodes.push(textBlock('normal', '</details>'));
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex]!;
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      continue;
    }

    if (TRANSLATE_OPEN_PATTERN.test(line)) {
      flushParagraph();
      let summary = 'Show English translation';
      const bodyLines: string[] = [];
      lineIndex += 1;
      while (lineIndex < lines.length) {
        const inner = lines[lineIndex]!.trim();
        if (!inner) {
          lineIndex += 1;
          continue;
        }
        if (TRANSLATE_CLOSE_PATTERN.test(inner)) {
          break;
        }
        const summaryMatch = inner.match(TRANSLATE_SUMMARY_PATTERN);
        if (summaryMatch) {
          summary = summaryMatch[1]!.trim();
          lineIndex += 1;
          continue;
        }
        bodyLines.push(inner);
        lineIndex += 1;
      }
      pushTranslateFold(summary, bodyLines.join(' ').trim());
      continue;
    }

    const blockquoteMatch = line.match(BLOCKQUOTE_PATTERN);
    if (blockquoteMatch) {
      flushParagraph();
      const quoteLines: string[] = [blockquoteMatch[1]!.trim()];
      while (lineIndex + 1 < lines.length) {
        const next = lines[lineIndex + 1]!.trim();
        const nextQuote = next.match(BLOCKQUOTE_PATTERN);
        if (!nextQuote) break;
        quoteLines.push(nextQuote[1]!.trim());
        lineIndex += 1;
      }
      nodes.push(textBlock('blockquote', quoteLines.join(' ')));
      continue;
    }

    const headingMatch = line.match(/^(#{2,4})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1]!.length;
      const style = level === 2 ? 'h2' : level === 3 ? 'h3' : 'h4';
      nodes.push(textBlock(style, headingMatch[2]!.trim()));
      continue;
    }

    const videoMatch = line.match(VIDEO_PATTERN);
    if (videoMatch) {
      flushParagraph();
      try {
        const parsed = JSON.parse(videoMatch[1]!) as Record<string, unknown>;
        if (parsed._type === 'video' && typeof parsed.url === 'string') {
          nodes.push({ _type: 'video', url: parsed.url });
          continue;
        }
        if (parsed._type === 'audio' && typeof parsed.url === 'string') {
          nodes.push({ _type: 'audio', url: parsed.url });
          continue;
        }
      } catch {
        /* fall through */
      }
    }

    const imageMatch = line.match(IMAGE_PATTERN);
    if (imageMatch) {
      flushParagraph();
      nodes.push({
        _type: 'image',
        asset: { url: normalizeMediaUrl(imageMatch[2]!) },
        alt: imageMatch[1]!.trim(),
      });
      continue;
    }

    paragraphBuffer.push(line);
  }

  flushParagraph();
  return nodes;
}
