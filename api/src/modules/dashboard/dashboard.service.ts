import type { PrismaClient } from "../../generated/prisma/client.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getDashboardOverview(
  prisma: PrismaClient,
  permissions: string[],
) {
  const canViewAccumulation = permissions.includes("akumulasi:view");
  const canViewDistribution = permissions.includes("distribusi:view");
  const canViewSmartMoney = permissions.includes("smartmoney:view");
  const since = new Date(Date.now() - DAY_MS);

  const [
    activeAccumulation,
    activeDistribution,
    recentSignals,
    recentSmartMoney,
    smartMoneySummary,
  ] = await Promise.all([
    canViewAccumulation
      ? prisma.tradeSignal.count({
          where: { status: "ACTIVE", direction: "ACCUMULATION" },
        })
      : Promise.resolve(null),
    canViewDistribution
      ? prisma.tradeSignal.count({
          where: { status: "ACTIVE", direction: "DISTRIBUTION" },
        })
      : Promise.resolve(null),
    canViewAccumulation || canViewDistribution
      ? prisma.tradeSignal.findMany({
          where: {
            status: "ACTIVE",
            direction: {
              in: [
                ...(canViewAccumulation ? (["ACCUMULATION"] as const) : []),
                ...(canViewDistribution ? (["DISTRIBUTION"] as const) : []),
              ],
            },
          },
          orderBy: { lastConfirmedAt: "desc" },
          take: 5,
          select: {
            id: true,
            symbol: true,
            baseAsset: true,
            direction: true,
            style: true,
            currentPrice: true,
            netFlowUsdt: true,
            startedAt: true,
            lastConfirmedAt: true,
          },
        })
      : Promise.resolve(null),
    canViewSmartMoney
      ? prisma.smartMoneyTrade.findMany({
          where: { tradedAt: { gte: since } },
          orderBy: { tradedAt: "desc" },
          take: 5,
          select: {
            id: true,
            symbol: true,
            side: true,
            notionalUsdt: true,
            tradedAt: true,
          },
        })
      : Promise.resolve(null),
    canViewSmartMoney
      ? prisma.smartMoneyTrade.groupBy({
          by: ["side"],
          where: { tradedAt: { gte: since } },
          _count: { _all: true },
          _sum: { notionalUsdt: true },
        })
      : Promise.resolve(null),
  ]);

  const smartMoneyGroup = smartMoneySummary ?? [];
  const buyGroup = smartMoneyGroup.find((group) => group.side === "TAKER_BUY");
  const sellGroup = smartMoneyGroup.find((group) => group.side === "TAKER_SELL");

  return {
    fetchedAt: new Date().toISOString(),
    metrics: {
      activeAccumulation,
      activeDistribution,
      smartMoneyTrades24h:
        canViewSmartMoney
          ? smartMoneyGroup.reduce((sum, group) => sum + group._count._all, 0)
          : null,
      smartMoneyBuyUsdt24h:
        canViewSmartMoney
          ? Number(buyGroup?._sum.notionalUsdt ?? 0)
          : null,
      smartMoneySellUsdt24h:
        canViewSmartMoney
          ? Number(sellGroup?._sum.notionalUsdt ?? 0)
          : null,
    },
    recentSignals:
      recentSignals?.map((signal) => ({
        id: signal.id.toString(),
        symbol: signal.symbol,
        baseAsset: signal.baseAsset,
        direction: signal.direction,
        style: signal.style,
        currentPrice: Number(signal.currentPrice),
        netFlowUsdt: Number(signal.netFlowUsdt),
        startedAt: signal.startedAt.toISOString(),
        lastConfirmedAt: signal.lastConfirmedAt.toISOString(),
      })) ?? null,
    recentSmartMoney:
      recentSmartMoney?.map((trade) => ({
        id: trade.id.toString(),
        symbol: trade.symbol,
        side: trade.side,
        notionalUsdt: Number(trade.notionalUsdt),
        tradedAt: trade.tradedAt.toISOString(),
      })) ?? null,
  };
}
