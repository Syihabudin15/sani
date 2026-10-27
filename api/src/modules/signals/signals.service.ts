import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../../generated/prisma/client.js";

const BINANCE_API = "https://api.binance.com/api/v3";
const COINPAPRIKA_API = "https://api.coinpaprika.com/v1";
const FLOW_THRESHOLD = 0.15;
const VOLUME_SPIKE_THRESHOLD = 1.5;
const SUPPLY_CACHE_TTL_MS = 60 * 60 * 1000;
const WORKER_COUNT = 8;

type SignalStyle = "SHORT" | "SWING";
type SignalDirection = "ACCUMULATION" | "DISTRIBUTION";

type Market = {
  symbol: string;
  baseAsset: string;
};

type Supply = {
  total: number | null;
  max: number | null;
  circulating: number | null;
};

type Candle = {
  closeTime: number;
  close: number;
  volume: number;
  quoteVolume: number;
  takerBuyVolume: number;
  takerBuyQuoteVolume: number;
};

type SignalSnapshot = {
  market: Market;
  direction: SignalDirection;
  style: SignalStyle;
  interval: "1h" | "4h";
  price: number;
  netFlowAmount: number;
  netFlowUsdt: number;
  flowRatio: number;
  volumeSpikeRatio: number;
  supply: Supply;
};

type Evaluation = {
  market: Market;
  style: SignalStyle;
  evaluable: boolean;
  signal: SignalSnapshot | null;
};

type BinanceExchangeInfo = {
  symbols?: Array<{
    symbol?: string;
    baseAsset?: string;
    quoteAsset?: string;
    status?: string;
    isSpotTradingAllowed?: boolean;
  }>;
};

type CoinPaprikaTicker = {
  symbol?: string;
  total_supply?: unknown;
  max_supply?: unknown;
  circulating_supply?: unknown;
  quotes?: { USD?: { price?: unknown; market_cap?: unknown } };
};

let cachedSupplyMap = new Map<string, Supply>();
let cachedSupplyAt = 0;

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Sumber data mengembalikan HTTP ${response.status}.`);
  }
  return response.json();
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function loadNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

async function loadMarkets(): Promise<Market[]> {
  const data = (await fetchJson(`${BINANCE_API}/exchangeInfo`)) as BinanceExchangeInfo;
  if (!Array.isArray(data.symbols)) {
    throw new Error("Daftar pasangan Binance tidak memiliki format yang valid.");
  }

  return data.symbols.flatMap((item) => {
    if (
      item.status !== "TRADING" ||
      item.quoteAsset !== "USDT" ||
      !item.symbol ||
      !item.baseAsset ||
      item.isSpotTradingAllowed === false
    ) {
      return [];
    }

    return [{ symbol: item.symbol, baseAsset: item.baseAsset }];
  });
}

async function loadSupplies(logger: FastifyBaseLogger): Promise<Map<string, Supply>> {
  if (Date.now() - cachedSupplyAt < SUPPLY_CACHE_TTL_MS && cachedSupplyMap.size > 0) {
    return cachedSupplyMap;
  }

  try {
    const data = (await fetchJson(`${COINPAPRIKA_API}/tickers?quotes=USD`)) as unknown;
    if (!Array.isArray(data)) {
      throw new Error("Respons supply CoinPaprika bukan daftar ticker.");
    }

    const candidates = new Map<
      string,
      { supply: Supply; marketCap: number }
    >();
    for (const rawTicker of data as CoinPaprikaTicker[]) {
      const symbol = rawTicker.symbol?.trim().toUpperCase();
      if (!symbol) continue;

      const marketCap = finiteNumber(rawTicker.quotes?.USD?.market_cap) ?? 0;
      const price = finiteNumber(rawTicker.quotes?.USD?.price) ?? 0;
      const supply = {
        total: loadNumber(rawTicker.total_supply),
        max: loadNumber(rawTicker.max_supply),
        circulating:
          loadNumber(rawTicker.circulating_supply) ??
          (marketCap > 0 && price > 0 ? marketCap / price : null),
      };
      const previous = candidates.get(symbol);
      if (!previous || marketCap > previous.marketCap) {
        candidates.set(symbol, { supply, marketCap });
      }
    }

    cachedSupplyMap = new Map(
      [...candidates].map(([symbol, entry]) => [symbol, entry.supply]),
    );
    cachedSupplyAt = Date.now();
    return cachedSupplyMap;
  } catch (error) {
    logger.warn(
      { err: error, hasCachedData: cachedSupplyMap.size > 0 },
      "Gagal memperbarui data supply CoinPaprika.",
    );
    if (cachedSupplyMap.size > 0) return cachedSupplyMap;
    return new Map();
  }
}

function parseCandles(data: unknown): Candle[] {
  if (!Array.isArray(data)) {
    throw new Error("Data candle Binance bukan daftar candle.");
  }

  return data.flatMap((raw) => {
    if (!Array.isArray(raw) || raw.length < 11) return [];
    const closeTime = finiteNumber(raw[6]);
    const close = finiteNumber(raw[4]);
    const volume = finiteNumber(raw[5]);
    const quoteVolume = finiteNumber(raw[7]);
    const takerBuyVolume = finiteNumber(raw[9]);
    const takerBuyQuoteVolume = finiteNumber(raw[10]);
    if (
      closeTime === null ||
      close === null ||
      volume === null ||
      quoteVolume === null ||
      takerBuyVolume === null ||
      takerBuyQuoteVolume === null
    ) {
      return [];
    }
    return [{
      closeTime,
      close,
      volume,
      quoteVolume,
      takerBuyVolume,
      takerBuyQuoteVolume,
    }];
  });
}

async function evaluateMarket(
  market: Market,
  style: SignalStyle,
  interval: "1h" | "4h",
  supplyMap: Map<string, Supply>,
): Promise<Evaluation> {
  const data = await fetchJson(
    `${BINANCE_API}/klines?symbol=${encodeURIComponent(market.symbol)}&interval=${interval}&limit=24`,
  );
  const now = Date.now();
  const candles = parseCandles(data).filter((candle) => candle.closeTime < now);
  if (candles.length < 23) {
    return { market, style, evaluable: false, signal: null };
  }

  const baseline = candles.slice(-23, -3);
  const recent = candles.slice(-3);
  const baselineQuoteVolume = baseline.reduce(
    (sum, candle) => sum + candle.quoteVolume,
    0,
  );
  const recentQuoteVolume = recent.reduce(
    (sum, candle) => sum + candle.quoteVolume,
    0,
  );
  const recentBaseVolume = recent.reduce(
    (sum, candle) => sum + candle.volume,
    0,
  );
  const recentTakerBuyVolume = recent.reduce(
    (sum, candle) => sum + candle.takerBuyVolume,
    0,
  );
  const recentQuoteVolumeAsNumber = recentQuoteVolume;
  const recentTakerBuyQuoteVolume = recent.reduce(
    (sum, candle) => sum + candle.takerBuyQuoteVolume,
    0,
  );
  const flowRatio =
    recentBaseVolume > 0
      ? (2 * recentTakerBuyVolume - recentBaseVolume) / recentBaseVolume
      : 0;
  const volumeSpikeRatio =
    baselineQuoteVolume > 0
      ? recentQuoteVolumeAsNumber / (baselineQuoteVolume / baseline.length * recent.length)
      : 0;

  if (
    Math.abs(flowRatio) < FLOW_THRESHOLD ||
    volumeSpikeRatio < VOLUME_SPIKE_THRESHOLD
  ) {
    return { market, style, evaluable: true, signal: null };
  }

  const netFlowAmount = 2 * recentTakerBuyVolume - recentBaseVolume;
  const netFlowUsdt = 2 * recentTakerBuyQuoteVolume - recentQuoteVolume;
  const supply = supplyMap.get(market.baseAsset.toUpperCase()) ?? {
    total: null,
    max: null,
    circulating: null,
  };

  return {
    market,
    style,
    evaluable: true,
    signal: {
      market,
      direction: flowRatio > 0 ? "ACCUMULATION" : "DISTRIBUTION",
      style,
      interval,
      price: candles[candles.length - 1].close,
      netFlowAmount,
      netFlowUsdt,
      flowRatio,
      volumeSpikeRatio,
      supply,
    },
  };
}

function decimal(value: number | null, digits: number): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(digits);
}

function supplyPercent(amount: number, supply: number | null): string | null {
  if (supply === null || supply <= 0) return null;
  return decimal((Math.abs(amount) / supply) * 100, 12);
}

async function persistEvaluations(
  prisma: PrismaClient,
  evaluations: Evaluation[],
  availableSymbols: Set<string>,
): Promise<{ created: number; invalidated: number; updated: number }> {
  const activeSignals = await prisma.tradeSignal.findMany({
    where: { status: "ACTIVE" },
  });
  const activeByKey = new Map(
    activeSignals.map((signal) => [`${signal.symbol}:${signal.style}`, signal]),
  );
  const counts = { created: 0, invalidated: 0, updated: 0 };
  const now = new Date();

  for (const evaluation of evaluations) {
    if (!evaluation.evaluable) continue;

    const key = `${evaluation.market.symbol}:${evaluation.style}`;
    const existing = activeByKey.get(key);
    if (evaluation.signal) {
      const signal = evaluation.signal;
      const data = {
        baseAsset: signal.market.baseAsset,
        direction: signal.direction,
        interval: signal.interval,
        lastConfirmedAt: now,
        closedAt: null,
        currentPrice: decimal(signal.price, 12)!,
        netFlowAmount: decimal(signal.netFlowAmount, 12)!,
        netFlowUsdt: decimal(signal.netFlowUsdt, 8)!,
        flowRatio: decimal(signal.flowRatio, 8)!,
        volumeSpikeRatio: decimal(signal.volumeSpikeRatio, 6)!,
        totalSupply: decimal(signal.supply.total, 12),
        maxSupply: decimal(signal.supply.max, 12),
        circulatingSupply: decimal(signal.supply.circulating, 12),
        percentOfTotalSupply: supplyPercent(
          signal.netFlowAmount,
          signal.supply.total,
        ),
        percentOfMaxSupply: supplyPercent(
          signal.netFlowAmount,
          signal.supply.max,
        ),
        percentOfCirculating: supplyPercent(
          signal.netFlowAmount,
          signal.supply.circulating,
        ),
      };

      if (existing && existing.direction !== signal.direction) {
        await prisma.tradeSignal.update({
          where: { id: existing.id },
          data: { status: "INVALIDATED", closedAt: now },
        });
        activeByKey.delete(key);
        counts.invalidated += 1;
      }

      const current = activeByKey.get(key);
      if (current) {
        await prisma.tradeSignal.update({
          where: { id: current.id },
          data,
        });
        counts.updated += 1;
      } else {
        const created = await prisma.tradeSignal.create({
          data: {
            ...data,
            symbol: signal.market.symbol,
            style: signal.style,
            status: "ACTIVE",
            startedAt: now,
          },
        });
        activeByKey.set(key, created);
        counts.created += 1;
      }
    } else if (existing) {
      await prisma.tradeSignal.update({
        where: { id: existing.id },
        data: { status: "INVALIDATED", closedAt: now },
      });
      activeByKey.delete(key);
      counts.invalidated += 1;
    }
  }

  for (const signal of activeByKey.values()) {
    if (!availableSymbols.has(signal.symbol)) {
      await prisma.tradeSignal.update({
        where: { id: signal.id },
        data: { status: "INVALIDATED", closedAt: now },
      });
      counts.invalidated += 1;
    }
  }

  return counts;
}

export async function scanAndPersistSignals(
  prisma: PrismaClient,
  logger: FastifyBaseLogger,
): Promise<void> {
  const markets = await loadMarkets();
  if (markets.length === 0) {
    throw new Error("Tidak ada pasangan Binance Spot USDT yang dapat dipindai.");
  }

  const supplies = await loadSupplies(logger);
  const evaluations: Evaluation[] = [];
  let nextMarket = 0;
  const failureSamples: Array<{
    symbol: string;
    style: SignalStyle;
    message: string;
  }> = [];
  let failures = 0;

  async function worker() {
    while (nextMarket < markets.length) {
      const market = markets[nextMarket];
      nextMarket += 1;

      const results = await Promise.all(
        ([
          { style: "SHORT", interval: "1h" },
          { style: "SWING", interval: "4h" },
        ] as const).map(async ({ style, interval }) => {
          try {
            return await evaluateMarket(market, style, interval, supplies);
          } catch (error) {
            failures += 1;
            if (failureSamples.length < 10) {
              failureSamples.push({
                symbol: market.symbol,
                style,
                message:
                  error instanceof Error ? error.message : "Kesalahan tidak diketahui.",
              });
            }
            return null;
          }
        }),
      );
      evaluations.push(
        ...results.filter((result): result is Evaluation => result !== null),
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(WORKER_COUNT, markets.length) }, () => worker()),
  );
  const counts = await persistEvaluations(
    prisma,
    evaluations,
    new Set(markets.map((market) => market.symbol)),
  );
  logger.info(
    { markets: markets.length, evaluations: evaluations.length, failures, ...counts },
    "Pemindaian sinyal pasar selesai.",
  );
  if (failures > 0) {
    logger.warn(
      { failures, evaluated: evaluations.length, samples: failureSamples },
      "Sebagian pasangan gagal dipindai; sinyalnya dibiarkan tanpa perubahan.",
    );
  }
}

export async function getActiveSignals(
  prisma: PrismaClient,
  direction: SignalDirection,
  style?: SignalStyle,
) {
  const now = new Date();
  const rows = await prisma.tradeSignal.findMany({
    where: {
      direction,
      status: "ACTIVE",
      ...(style ? { style } : {}),
    },
    orderBy: [{ lastConfirmedAt: "desc" }, { symbol: "asc" }],
  });

  return {
    fetchedAt: now.toISOString(),
    data: rows.map((row) => ({
      id: row.id.toString(),
      symbol: row.symbol,
      baseAsset: row.baseAsset,
      direction: row.direction,
      style: row.style,
      interval: row.interval,
      startedAt: row.startedAt.toISOString(),
      lastConfirmedAt: row.lastConfirmedAt.toISOString(),
      durationMs: Math.max(0, now.getTime() - row.startedAt.getTime()),
      currentPrice: Number(row.currentPrice),
      netFlowAmount: Number(row.netFlowAmount),
      netFlowUsdt: Number(row.netFlowUsdt),
      flowRatio: Number(row.flowRatio),
      volumeSpikeRatio: Number(row.volumeSpikeRatio),
      totalSupply: row.totalSupply === null ? null : Number(row.totalSupply),
      maxSupply: row.maxSupply === null ? null : Number(row.maxSupply),
      circulatingSupply:
        row.circulatingSupply === null ? null : Number(row.circulatingSupply),
      percentOfTotalSupply:
        row.percentOfTotalSupply === null
          ? null
          : Number(row.percentOfTotalSupply),
      percentOfMaxSupply:
        row.percentOfMaxSupply === null ? null : Number(row.percentOfMaxSupply),
      percentOfCirculating:
        row.percentOfCirculating === null
          ? null
          : Number(row.percentOfCirculating),
    })),
  };
}
