import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../../generated/prisma/client.js";

const BINANCE_API = "https://api.binance.com/api/v3";
const MIN_NOTIONAL_USDT = 100_000;
const RETENTION_DAYS = 7;
const TRADES_PER_SYMBOL = 1_000;
const WORKER_COUNT = 4;

type Market = {
  symbol: string;
};

type BinanceExchangeInfo = {
  symbols?: Array<{
    symbol?: string;
    quoteAsset?: string;
    status?: string;
    isSpotTradingAllowed?: boolean;
  }>;
};

type BinanceAggregateTrade = {
  a?: unknown;
  p?: unknown;
  q?: unknown;
  T?: unknown;
  m?: unknown;
};

type StoredTrade = {
  symbol: string;
  aggregateTradeId: bigint;
  side: "TAKER_BUY" | "TAKER_SELL";
  price: string;
  quantity: string;
  notionalUsdt: string;
  tradedAt: Date;
};

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Binance mengembalikan HTTP ${response.status}.`);
  }
  return response.json();
}

function readNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

async function loadMarkets(): Promise<Market[]> {
  const result = (await fetchJson(`${BINANCE_API}/exchangeInfo`)) as BinanceExchangeInfo;
  if (!Array.isArray(result.symbols)) {
    throw new Error("Daftar pasangan Binance tidak memiliki format yang valid.");
  }

  return result.symbols.flatMap((market) => {
    if (
      market.status !== "TRADING" ||
      market.quoteAsset !== "USDT" ||
      !market.symbol ||
      market.isSpotTradingAllowed === false
    ) {
      return [];
    }

    return [{ symbol: market.symbol }];
  });
}

async function loadLargeTrades(
  market: Market,
  cutoff: number,
): Promise<StoredTrade[]> {
  const result = (await fetchJson(
    `${BINANCE_API}/aggTrades?symbol=${encodeURIComponent(market.symbol)}&limit=${TRADES_PER_SYMBOL}`,
  )) as unknown;
  if (!Array.isArray(result)) {
    throw new Error(`Data transaksi ${market.symbol} bukan daftar transaksi.`);
  }

  return (result as BinanceAggregateTrade[]).flatMap((trade) => {
    const aggregateTradeId =
      typeof trade.a === "number" || typeof trade.a === "string"
        ? BigInt(trade.a)
        : null;
    const price = readNumber(trade.p);
    const quantity = readNumber(trade.q);
    const timestamp = readNumber(trade.T);
    if (
      aggregateTradeId === null ||
      price === null ||
      quantity === null ||
      timestamp === null ||
      typeof trade.m !== "boolean" ||
      timestamp < cutoff
    ) {
      return [];
    }

    const notionalUsdt = price * quantity;
    if (!Number.isFinite(notionalUsdt) || notionalUsdt < MIN_NOTIONAL_USDT) {
      return [];
    }

    return [{
      symbol: market.symbol,
      aggregateTradeId,
      side: trade.m ? "TAKER_SELL" : "TAKER_BUY",
      price: price.toFixed(12),
      quantity: quantity.toFixed(12),
      notionalUsdt: notionalUsdt.toFixed(8),
      tradedAt: new Date(timestamp),
    }];
  });
}

export async function scanAndPersistSmartMoney(
  prisma: PrismaClient,
  logger: FastifyBaseLogger,
): Promise<void> {
  const markets = await loadMarkets();
  if (markets.length === 0) {
    throw new Error("Tidak ada pasangan Binance Spot USDT yang dapat dipindai.");
  }

  const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const collectedTrades: StoredTrade[] = [];
  const failedMarkets: Array<{ symbol: string; message: string }> = [];
  let nextMarket = 0;

  async function worker() {
    while (nextMarket < markets.length) {
      const market = markets[nextMarket];
      nextMarket += 1;
      try {
        collectedTrades.push(
          ...(await loadLargeTrades(market, cutoffDate.getTime())),
        );
      } catch (error) {
        if (failedMarkets.length < 20) {
          failedMarkets.push({
            symbol: market.symbol,
            message:
              error instanceof Error ? error.message : "Kesalahan tidak diketahui.",
          });
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(WORKER_COUNT, markets.length) }, () => worker()),
  );

  if (collectedTrades.length > 0) {
    await prisma.smartMoneyTrade.createMany({
      data: collectedTrades,
      skipDuplicates: true,
    });
  }
  await prisma.smartMoneyTrade.deleteMany({
    where: { tradedAt: { lt: cutoffDate } },
  });

  logger.info(
    {
      markets: markets.length,
      collected: collectedTrades.length,
      failedMarkets: failedMarkets.length,
    },
    "Pemindaian transaksi besar SmartMoney selesai.",
  );
  if (failedMarkets.length > 0) {
    logger.warn(
      { failedMarkets },
      "Sebagian pair gagal dipindai; data yang sudah tersimpan tetap dipertahankan.",
    );
  }
}

export async function getSmartMoneyTrades(
  prisma: PrismaClient,
  options: { side?: "TAKER_BUY" | "TAKER_SELL"; limit: number },
) {
  const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const where = {
    tradedAt: { gte: cutoffDate },
    ...(options.side ? { side: options.side } : {}),
  };
  const [rows, groups, total] = await Promise.all([
    prisma.smartMoneyTrade.findMany({
      where,
      orderBy: [{ tradedAt: "desc" }, { id: "desc" }],
      take: options.limit,
    }),
    prisma.smartMoneyTrade.groupBy({
      by: ["side"],
      where: { tradedAt: { gte: cutoffDate } },
      _count: { _all: true },
      _sum: { notionalUsdt: true },
    }),
    prisma.smartMoneyTrade.count({ where }),
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    minimumNotionalUsdt: MIN_NOTIONAL_USDT,
    retentionDays: RETENTION_DAYS,
    total,
    summary: {
      takerBuy: {
        count: groups.find((group) => group.side === "TAKER_BUY")?._count._all ?? 0,
        notionalUsdt: Number(
          groups.find((group) => group.side === "TAKER_BUY")?._sum.notionalUsdt ?? 0,
        ),
      },
      takerSell: {
        count: groups.find((group) => group.side === "TAKER_SELL")?._count._all ?? 0,
        notionalUsdt: Number(
          groups.find((group) => group.side === "TAKER_SELL")?._sum.notionalUsdt ?? 0,
        ),
      },
    },
    data: rows.map((row) => ({
      id: row.id.toString(),
      symbol: row.symbol,
      side: row.side,
      price: Number(row.price),
      quantity: Number(row.quantity),
      notionalUsdt: Number(row.notionalUsdt),
      tradedAt: row.tradedAt.toISOString(),
    })),
  };
}
