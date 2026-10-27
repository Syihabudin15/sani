import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import fp from "fastify-plugin";
import { PrismaClient } from "../generated/prisma/client.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

type PrismaPluginOptions = {
  databaseUrl: string;
};

export const prismaPlugin = fp<PrismaPluginOptions>(
  async (app, options) => {
    const adapter = new PrismaMariaDb(options.databaseUrl);
    const prisma = new PrismaClient({ adapter });

    await prisma.$connect();
    app.decorate("prisma", prisma);
    app.addHook("onClose", async () => {
      await prisma.$disconnect();
    });
  },
  { name: "prisma" },
);
