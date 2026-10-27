import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/env.js";
import { registerNewsRoutes } from "./modules/news/news.route.js";
import { prismaPlugin } from "./plugins/prisma.plugin.js";
import { authPlugin } from "./plugins/auth.plugin.js";
import { registerAuthRoutes } from "./modules/auth/auth.route.js";
import { registerRoleRoutes } from "./modules/roles/roles.route.js";
import { registerUserRoutes } from "./modules/users/users.route.js";
import { registerSignalRoutes } from "./modules/signals/signals.route.js";
import { signalScannerPlugin } from "./modules/signals/signals.plugin.js";
import { smartMoneyScannerPlugin } from "./modules/smartmoney/smartmoney.plugin.js";
import { registerSmartMoneyRoutes } from "./modules/smartmoney/smartmoney.route.js";
import { registerDashboardRoutes } from "./modules/dashboard/dashboard.route.js";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";

export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return payload;
  });

  void app.register(rateLimit, { global: false });
  void app.register(cookie);
  void app.register(prismaPlugin, { databaseUrl: config.databaseUrl });
  void app.register(authPlugin, {
    cookieName: config.sessionCookieName,
  });
  void app.register(signalScannerPlugin, {
    intervalMinutes: config.signalsScanIntervalMinutes,
  });
  void app.register(smartMoneyScannerPlugin, {
    intervalMinutes: config.smartMoneyScanIntervalMinutes,
  });
  void app.register(
    async (api) => {
      await api.register(registerAuthRoutes, {
        cookieName: config.sessionCookieName,
        sessionTtlHours: config.sessionTtlHours,
        secureCookies: config.secureCookies,
      });
      await api.register(registerRoleRoutes);
      await api.register(registerUserRoutes);
      await api.register(registerNewsRoutes);
      await api.register(registerSignalRoutes);
      await api.register(registerSmartMoneyRoutes);
      await api.register(registerDashboardRoutes);
    },
    { prefix: "/api" },
  );

  return app;
}
