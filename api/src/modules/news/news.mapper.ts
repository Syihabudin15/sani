import type { NewsArticle } from "./news.types.js";

export type RssRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is RssRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (isRecord(value)) {
      const nested = stringValue(value["#cdata"], value["#text"]);
      if (nested) return nested;
    }

    if (
      typeof value === "string" ||
      typeof value === "number"
    ) {
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  return "";
}

export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function firstImage(...values: unknown[]): string | null {
  for (const value of values) {
    if (isRecord(value)) {
      const image = safeUrl(value["@_url"] ?? value.url);
      if (image) return image;
    }

    const image = safeUrl(value);
    if (image) return image;
  }
  return null;
}

export function normalizeArticle(
  value: unknown,
  source: string,
): NewsArticle | null {
  if (!isRecord(value)) return null;

  const title = stripHtml(stringValue(value.title));
  const url = safeUrl(stringValue(value.link));
  if (!title || !url) return null;

  const description = stringValue(value.description, value["content:encoded"]);
  const embeddedImage = description.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  const rawId = stringValue(value.guid, value.id, url);
  const image = firstImage(
    value["media:content"],
    value["media:thumbnail"],
    embeddedImage,
  );
  const publishedAt = stringValue(value.pubDate, value["dc:date"]);

  return {
    id: `${source}:${rawId}`,
    title,
    description: stripHtml(description),
    source,
    url,
    imageUrl: image,
    publishedAt: publishedAt || null,
  };
}
