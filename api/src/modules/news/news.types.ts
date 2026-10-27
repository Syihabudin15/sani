export type NewsArticle = {
  id: string;
  title: string;
  description: string;
  source: string;
  url: string;
  imageUrl: string | null;
  publishedAt: string | null;
};

export type NewsResponse = {
  data: NewsArticle[];
  fetchedAt: string;
  warnings?: string[];
};

export class NewsServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: 502,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NewsServiceError";
  }
}
