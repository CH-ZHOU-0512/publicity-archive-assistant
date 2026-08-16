const WINDOWS_INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function sanitizeFilenamePart(value: string, maxLength = 110): string {
  let cleaned = value
    .normalize("NFKC")
    .replace(WINDOWS_INVALID, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  if (!cleaned) cleaned = "未命名文章";
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  if (cleaned.length > maxLength) cleaned = cleaned.slice(0, maxLength).trimEnd();
  return cleaned;
}

export function buildPdfFilename(title: string, publishedDate: string): string {
  return `${sanitizeFilenamePart(title)}_${publishedDate}.pdf`;
}

export function normalizePublishedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/[年月/.]/g, "-").replace(/日/g, "");
  const match = normalized.match(/(?:^|\D)((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})(?:\D|$)/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeTitle(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || null;
}
