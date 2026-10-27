import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { FastifyPluginAsync } from "fastify";
import { hashSessionToken, requireAuthenticated } from "../../plugins/auth.plugin.js";

const DUMMY_PASSWORD_HASH = await argon2.hash(randomBytes(32).toString("base64url"));

type AuthRouteOptions = {
  cookieName: string;
  sessionTtlHours: number;
  secureCookies: boolean;
};

type LoginBody = {
  username: string;
  password: string;
  remember?: boolean;
};

export const registerAuthRoutes: FastifyPluginAsync<AuthRouteOptions> = async (
  app,
  options,
) => {
  app.post<{ Body: LoginBody }>(
    "/auth/login",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 1, maxLength: 50 },
            password: { type: "string", minLength: 1, maxLength: 200 },
            remember: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const username = request.body.username.trim();
      const user = await app.prisma.user.findUnique({
        where: { username },
        select: {
          id: true,
          username: true,
          email: true,
          passwordHash: true,
          isActive: true,
          role: {
            select: {
              id: true,
              name: true,
              isSystem: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      });

      const passwordValid = await argon2.verify(
        user?.passwordHash ?? DUMMY_PASSWORD_HASH,
        request.body.password,
      );
      if (!user || !passwordValid || !user.isActive) {
        return reply.code(401).send({ error: "Username atau password salah." });
      }

      const token = randomBytes(32).toString("base64url");
      const remember = request.body.remember === true;
      const ttlHours = remember
        ? Math.min(options.sessionTtlHours * 30, 720)
        : options.sessionTtlHours;
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

      await app.prisma.$transaction([
        app.prisma.session.deleteMany({
          where: { userId: user.id, expiresAt: { lte: new Date() } },
        }),
        app.prisma.session.create({
          data: {
            tokenHash: hashSessionToken(token),
            userId: user.id,
            expiresAt,
          },
        }),
        app.prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        }),
      ]);

      reply.setCookie(options.cookieName, token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/api",
        secure: options.secureCookies,
        expires: expiresAt,
      });

      return {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          permissions: user.role.permissions.map(
            ({ permission }) => permission.key,
          ),
        },
      };
    },
  );

  app.get(
    "/auth/me",
    { preHandler: requireAuthenticated() },
    async (request) => ({ user: request.auth }),
  );

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[options.cookieName];
    if (token) {
      await app.prisma.session.deleteMany({
        where: { tokenHash: hashSessionToken(token) },
      });
    }

    reply.clearCookie(options.cookieName, {
      httpOnly: true,
      sameSite: "lax",
      path: "/api",
      secure: options.secureCookies,
    });
    return { success: true };
  });
};
