import type { FastifyPluginAsync } from "fastify";
import { getActiveSignals } from "./signals.service.js";
import { requirePermission } from "../../plugins/auth.plugin.js";

type SignalStyle = "SHORT" | "SWING";

function parseStyle(value: string | undefined): SignalStyle | undefined {
  if (value === undefined) return undefined;
  if (value === "SHORT" || value === "SWING") return value;
  throw Object.assign(new Error("style harus bernilai SHORT atau SWING."), {
    statusCode: 400,
  });
}

export const registerSignalRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { style?: string } }>(
    "/signals/accumulation",
    { preHandler: requirePermission("akumulasi:view") },
    async (request) =>
      getActiveSignals(
        app.prisma,
        "ACCUMULATION",
        parseStyle(request.query.style),
      ),
  );

  app.get<{ Querystring: { style?: string } }>(
    "/signals/distribution",
    { preHandler: requirePermission("distribusi:view") },
    async (request) =>
      getActiveSignals(
        app.prisma,
        "DISTRIBUTION",
        parseStyle(request.query.style),
      ),
  );
};
