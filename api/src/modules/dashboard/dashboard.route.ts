import type { FastifyPluginAsync } from "fastify";
import { getDashboardOverview } from "./dashboard.service.js";
import { requirePermission } from "../../plugins/auth.plugin.js";

export const registerDashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/dashboard/overview",
    { preHandler: requirePermission("dashboard:view") },
    async (request) =>
      getDashboardOverview(app.prisma, request.auth?.permissions ?? []),
  );
};
