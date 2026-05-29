/**
 * Quote delimiter patterns for European news text.
 *
 * One canonical list — not split by locale. Patterns match quote *glyphs* (straight,
 * curly, guillemets, German, mojibake), which can appear in any language feed.
 */

type QuotePatternSource = { source: string; flags: string };

/** Capturing-group patterns; group 1 is the quoted span. */
export const QUOTE_PATTERN_SOURCES: readonly QuotePatternSource[] = [
  // Straight ASCII
  { source: '"([^"]+)"', flags: 'g' },
  { source: "'([^']+)'", flags: 'g' },

  // Curly double quotes: “…” and „…”
  { source: '[\u201C\u201E]([^\u201C\u201D\u201E\u201F]+)[\u201D\u201F]', flags: 'g' },

  // German: „…“ (low-9 open, right double close)
  { source: '\u201E([^\u201E\u201D]+)\u201D', flags: 'g' },
  // German: „…“ (low-9 open, left double close)
  { source: '\u201E([^\u201E\u201C]+)\u201C', flags: 'g' },
  // German: „…" (low-9 open, straight close)
  { source: '\u201E([^\u201E"]+)"', flags: 'g' },

  // Guillemets: «…» and »…«
  { source: '\u00AB([^\u00AB\u00BB]+)\u00BB', flags: 'g' },
  { source: '\u00BB([^\u00AB\u00BB]+)\u00AB', flags: 'g' },
  // French guillemets with spaces: « … »
  { source: '\u00AB\\s+([^\u00AB\u00BB]+)\\s+\u00BB', flags: 'g' },

  // Curly single quotes: ‘…’
  { source: '[\u2018\u201A]([^\u2018\u2019\u201A\u201B]+)[\u2019\u201B]', flags: 'g' },

  // Mojibake (UTF-8 misread as Windows-1252 / ISO-8859-1)
  { source: 'ΓÇ₧([^ΓÇ₧ΓÇ£]+)ΓÇ£', flags: 'g' },
  { source: 'ΓÇ₧([^ΓÇ₧"]+)"', flags: 'g' },
  { source: '"([^"]+)ΓÇ£', flags: 'g' },
] as const;

/** Fresh RegExp instances — safe to reuse across multiple texts. */
export function quotePatterns(): RegExp[] {
  return QUOTE_PATTERN_SOURCES.map(({ source, flags }) => new RegExp(source, flags));
}

/** Extract raw quoted spans (capture group 1) from text. */
export function extractQuotedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const { source, flags } of QUOTE_PATTERN_SOURCES) {
    for (const match of text.matchAll(new RegExp(source, flags))) {
      const quoted = match[1];
      if (quoted) spans.push(quoted);
    }
  }
  return spans;
}
