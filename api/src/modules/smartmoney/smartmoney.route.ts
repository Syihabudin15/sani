import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../../plugins/auth.plugin.js";
import { getSmartMoneyTrades } from "./smartmoney.service.js";

type TradeSide = "TAKER_BUY" | "TAKER_SELL";

function parseSide(value: string | undefined): TradeSide | undefined {
  if (value === undefined) return undefined;
  if (value === "TAKER_BUY" || value === "TAKER_SELL") return value;
  throw Object.assign(
    new Error("side harus bernilai TAKER_BUY atau TAKER_SELL."),
    { statusCode: 400 },
  );
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 200;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw Object.assign(new Error("limit harus berupa angka antara 1 dan 500."), {
      statusCode: 400,
    });
  }
  return limit;
}

export const registerSmartMoneyRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { side?: string; limit?: string } }>(
    "/smartmoney/trades",
    { preHandler: requirePermission("smartmoney:view") },
    async (request) =>
      getSmartMoneyTrades(app.prisma, {
        side: parseSide(request.query.side),
        limit: parseLimit(request.query.limit),
      }),
  );
};
