/** Unicode apostrophe / modifier-letter variants → ASCII apostrophe (same set as headline matching). */
const UNICODE_APOSTROPHE_RE = /[\u2018\u2019\u201A\u201B\u2032\u02BC\uFF07]/g;

export function canonicalizeApostrophes(value: string): string {
  return value.replace(UNICODE_APOSTROPHE_RE, "'");
}
