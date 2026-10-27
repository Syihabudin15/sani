import { createHash } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";

export type AuthContext = {
  id: number;
  username: string;
  email: string | null;
  role: { id: number; name: string; isSystem: boolean };
  permissions: string[];
};

type AuthPluginOptions = {
  cookieName: string;
};

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
    authenticate: () => Promise<void>;
  }

}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const authPlugin = fp<AuthPluginOptions>(
  async (app, options) => {
    app.decorateRequest("auth", null);

    app.decorateRequest(
      "authenticate",
      async function authenticate(this: FastifyRequest) {
        const token = this.cookies[options.cookieName];
        if (!token) {
          this.auth = null;
          return;
        }

        const session = await app.prisma.session.findUnique({
          where: { tokenHash: hashSessionToken(token) },
          select: {
            id: true,
            expiresAt: true,
            user: {
              select: {
                id: true,
                username: true,
                email: true,
                isActive: true,
                role: {
                  select: {
                    id: true,
                    name: true,
                    isSystem: true,
                    permissions: {
                      select: { permission: { select: { key: true } } },
                    },
                  },
                },
              },
            },
          },
        });

        if (!session || session.expiresAt <= new Date() || !session.user.isActive) {
          this.auth = null;
          return;
        }

        this.auth = {
          id: session.user.id,
          username: session.user.username,
          email: session.user.email,
          role: session.user.role,
          permissions: session.user.role.permissions.map(
            ({ permission }) => permission.key,
          ),
        };
      },
    );
  },
  { name: "auth", dependencies: ["prisma"] },
);

export function requirePermission(permission: string) {
  return async function checkPermission(request: FastifyRequest) {
    await request.authenticate();
    if (!request.auth) {
      throw Object.assign(new Error("Silakan masuk terlebih dahulu."), {
        statusCode: 401,
      });
    }

    if (!request.auth.permissions.includes(permission)) {
      throw Object.assign(new Error("Anda tidak memiliki izin untuk tindakan ini."), {
        statusCode: 403,
      });
    }
  };
}

export function requireAuthenticated() {
  return async function checkAuthentication(request: FastifyRequest) {
    await request.authenticate();
    if (!request.auth) {
      throw Object.assign(new Error("Silakan masuk terlebih dahulu."), {
        statusCode: 401,
      });
    }
  };
}
