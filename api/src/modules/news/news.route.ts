import type { FastifyPluginAsync } from "fastify";
import { getLatestNews } from "./news.service.js";
import { NewsServiceError } from "./news.types.js";
import { requirePermission } from "../../plugins/auth.plugin.js";

export const registerNewsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/news",
    { preHandler: requirePermission("berita:view") },
    async (request, reply) => {
    try {
      return await getLatestNews(request.log);
    } catch (error) {
      if (error instanceof NewsServiceError) {
        if (error.statusCode === 502) {
          request.log.error({ err: error }, "Gagal mengambil feed berita.");
        }
        return reply.code(error.statusCode).send({ error: error.message });
      }

      request.log.error({ err: error }, "Kesalahan tak terduga pada endpoint berita.");
      return reply.code(500).send({
        error: "Terjadi kesalahan internal saat mengambil berita.",
      });
    }
    },
  );
};
