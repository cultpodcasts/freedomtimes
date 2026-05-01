export type ParsedFeedItem = {
  url: string;
  title: string | null;
  pubDate: string | null;
};

function decodeCdata(value: string): string {
  return value.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

function extractTag(block: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = block.match(regex);
  if (!match || !match[1]) {
    return null;
  }
  return decodeCdata(match[1]);
}

function parseRssItems(feedText: string): ParsedFeedItem[] {
  const matches = feedText.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const out: ParsedFeedItem[] = [];

  for (const item of matches) {
    const link = extractTag(item, 'link');
    if (!link) {
      continue;
    }

    out.push({
      url: link,
      title: extractTag(item, 'title'),
      pubDate: extractTag(item, 'pubDate'),
    });
  }

  return out;
}

function parseAtomEntries(feedText: string): ParsedFeedItem[] {
  const matches = feedText.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
  const out: ParsedFeedItem[] = [];

  for (const entry of matches) {
    const href = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1]?.trim() ?? null;
    const linkTag = extractTag(entry, 'link');
    const url = href ?? linkTag;

    if (!url) {
      continue;
    }

    out.push({
      url,
      title: extractTag(entry, 'title'),
      pubDate: extractTag(entry, 'updated') ?? extractTag(entry, 'published'),
    });
  }

  return out;
}

export function parseFeedItems(feedText: string): ParsedFeedItem[] {
  const atomItems = parseAtomEntries(feedText);
  const rssItems = parseRssItems(feedText);
  return atomItems.length >= rssItems.length ? atomItems : rssItems;
}
