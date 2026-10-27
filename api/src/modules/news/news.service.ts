import type { FastifyBaseLogger } from "fastify";
import { XMLParser } from "fast-xml-parser";
import { isRecord, normalizeArticle } from "./news.mapper.js";
import {
  NewsServiceError,
  type NewsArticle,
  type NewsResponse,
} from "./news.types.js";

const FEEDS = [
  {
    name: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/",
  },
  {
    name: "Cointelegraph",
    url: "https://cointelegraph.com/rss",
  },
] as const;

const FEED_TIMEOUT_MS = 15_000;
const MAX_ARTICLES = 40;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  parseTagValue: false,
  trimValues: true,
});

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

async function fetchFeed(
  feed: (typeof FEEDS)[number],
): Promise<NewsArticle[]> {
  const response = await fetch(feed.url, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml",
      "User-Agent": "SyrelAnalysisNews/1.0",
    },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${feed.name} merespons dengan status ${response.status}.`);
  }

  const xml = await response.text();
  const parsed: unknown = parser.parse(xml);
  if (!isRecord(parsed) || !isRecord(parsed.rss)) {
    throw new Error(`Format RSS ${feed.name} tidak valid.`);
  }

  const channel = parsed.rss.channel;
  if (!isRecord(channel)) {
    throw new Error(`Feed ${feed.name} tidak memiliki channel yang valid.`);
  }

  return asArray(channel.item)
    .map((item) => normalizeArticle(item, feed.name))
    .filter((article): article is NewsArticle => article !== null);
}

export async function getLatestNews(
  logger: FastifyBaseLogger,
): Promise<NewsResponse> {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const articles: NewsArticle[] = [];
  const warnings: string[] = [];
  let successfulFeeds = 0;

  results.forEach((result, index) => {
    const feed = FEEDS[index];
    if (result.status === "fulfilled") {
      successfulFeeds += 1;
      articles.push(...result.value);
      return;
    }

    logger.warn(
      { err: result.reason, source: feed.name },
      "Gagal mengambil feed berita.",
    );
    warnings.push(`${feed.name} tidak dapat diperbarui saat ini.`);
  });

  if (successfulFeeds === 0) {
    throw new NewsServiceError(
      "Semua sumber berita gagal diakses. Silakan coba lagi nanti.",
      502,
    );
  }

  const uniqueArticles = Array.from(
    new Map(articles.map((article) => [article.url, article])).values(),
  );
  uniqueArticles.sort((first, second) => {
    const firstTime = first.publishedAt
      ? Date.parse(first.publishedAt)
      : Number.NEGATIVE_INFINITY;
    const secondTime = second.publishedAt
      ? Date.parse(second.publishedAt)
      : Number.NEGATIVE_INFINITY;
    return secondTime - firstTime;
  });

  return {
    data: uniqueArticles.slice(0, MAX_ARTICLES),
    fetchedAt: new Date().toISOString(),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
