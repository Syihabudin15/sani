import argon2 from "argon2";
import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../../plugins/auth.plugin.js";

type UserParams = { id: string };
type CreateUserBody = {
  username: string;
  email?: string | null;
  password: string;
  roleId: number;
  isActive?: boolean;
};
type UpdateUserBody = {
  username?: string;
  email?: string | null;
  password?: string;
  roleId?: number;
  isActive?: boolean;
};

const userSelect = {
  id: true,
  username: true,
  email: true,
  isActive: true,
  roleId: true,
  lastLoginAt: true,
  createdAt: true,
  role: { select: { id: true, name: true, isSystem: true } },
} as const;

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isOptionalEmail(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isCreateBody(value: unknown): value is CreateUserBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.username === "string" &&
    body.username.trim().length >= 3 &&
    body.username.trim().length <= 50 &&
    typeof body.password === "string" &&
    body.password.length >= 12 &&
    body.password.length <= 200 &&
    typeof body.roleId === "number" &&
    Number.isInteger(body.roleId) &&
    body.roleId > 0 &&
    isOptionalEmail(body.email) &&
    (body.email === undefined || body.email === null || body.email.length <= 191) &&
    (body.isActive === undefined || typeof body.isActive === "boolean")
  );
}

function isUpdateBody(value: unknown): value is UpdateUserBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const allowed = ["username", "email", "password", "roleId", "isActive"];
  return (
    Object.keys(body).length > 0 &&
    Object.keys(body).every((key) => allowed.includes(key)) &&
    (body.username === undefined ||
      (typeof body.username === "string" &&
        body.username.trim().length >= 3 &&
        body.username.trim().length <= 50)) &&
    isOptionalEmail(body.email) &&
    (body.email === undefined || body.email === null || body.email.length <= 191) &&
    (body.password === undefined ||
      (typeof body.password === "string" &&
        body.password.length >= 12 &&
        body.password.length <= 200)) &&
    (body.roleId === undefined ||
      (typeof body.roleId === "number" &&
        Number.isInteger(body.roleId) &&
        body.roleId > 0)) &&
    (body.isActive === undefined || typeof body.isActive === "boolean")
  );
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export const registerUserRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/users/roles",
    { preHandler: requirePermission("data-pengguna:view") },
    async () =>
      app.prisma.role.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
  );

  app.get(
    "/users",
    { preHandler: requirePermission("data-pengguna:view") },
    async () =>
      app.prisma.user.findMany({
        orderBy: { createdAt: "desc" },
        select: userSelect,
      }),
  );

  app.post<{ Body: CreateUserBody }>(
    "/users",
    { preHandler: requirePermission("data-pengguna:create") },
    async (request, reply) => {
      if (!isCreateBody(request.body)) {
        return reply.code(400).send({
          error: "Data pengguna tidak valid. Password minimal 12 karakter.",
        });
      }

      const roleExists = await app.prisma.role.findUnique({
        where: { id: request.body.roleId },
        select: { id: true, isSystem: true },
      });
      if (!roleExists) return reply.code(400).send({ error: "Role tidak ditemukan." });
      if (roleExists.isSystem && !request.auth?.role.isSystem) {
        return reply.code(403).send({
          error: "Hanya administrator sistem yang dapat menetapkan role sistem.",
        });
      }

      try {
        const user = await app.prisma.user.create({
          data: {
            username: request.body.username.trim(),
            email: request.body.email?.trim() || null,
            passwordHash: await argon2.hash(request.body.password),
            roleId: request.body.roleId,
            isActive: request.body.isActive ?? true,
          },
          select: userSelect,
        });
        return reply.code(201).send(user);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return reply.code(409).send({ error: "Username atau email sudah digunakan." });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: UserParams; Body: UpdateUserBody }>(
    "/users/:id",
    { preHandler: requirePermission("data-pengguna:update") },
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (!id || !isUpdateBody(request.body)) {
        return reply.code(400).send({ error: "Data pengguna tidak valid." });
      }

      const current = await app.prisma.user.findUnique({
        where: { id },
        select: { id: true, roleId: true, role: { select: { isSystem: true } } },
      });
      if (!current) return reply.code(404).send({ error: "Pengguna tidak ditemukan." });

      const body = request.body;
      const disablingSelf = id === request.auth?.id && body.isActive === false;
      if (disablingSelf) {
        return reply.code(400).send({ error: "Anda tidak dapat menonaktifkan akun sendiri." });
      }

      if (
        current.role.isSystem &&
        (body.isActive === false ||
          (body.roleId !== undefined && body.roleId !== current.roleId))
      ) {
        return reply.code(400).send({
          error: "Akun administrator sistem tidak dapat dinonaktifkan atau dipindahkan role.",
        });
      }

      if (body.roleId !== undefined) {
        const role = await app.prisma.role.findUnique({
          where: { id: body.roleId },
          select: { isSystem: true },
        });
        if (!role) return reply.code(400).send({ error: "Role tidak ditemukan." });
        if (role.isSystem && !request.auth?.role.isSystem) {
          return reply.code(403).send({
            error: "Hanya administrator sistem yang dapat menetapkan role sistem.",
          });
        }
      }

      try {
        const user = await app.prisma.$transaction(async (transaction) => {
          const updated = await transaction.user.update({
            where: { id },
            data: {
              ...(body.username !== undefined && { username: body.username.trim() }),
              ...(body.email !== undefined && {
                email: body.email?.trim() || null,
              }),
              ...(body.password !== undefined && {
                passwordHash: await argon2.hash(body.password),
              }),
              ...(body.roleId !== undefined && { roleId: body.roleId }),
              ...(body.isActive !== undefined && { isActive: body.isActive }),
            },
            select: userSelect,
          });
          if (body.password !== undefined) {
            await transaction.session.deleteMany({ where: { userId: id } });
          }
          return updated;
        });
        return user;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return reply.code(409).send({ error: "Username atau email sudah digunakan." });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: UserParams }>(
    "/users/:id",
    { preHandler: requirePermission("data-pengguna:delete") },
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (!id) return reply.code(400).send({ error: "ID pengguna tidak valid." });
      if (id === request.auth?.id) {
        return reply.code(400).send({ error: "Anda tidak dapat menghapus akun sendiri." });
      }

      const user = await app.prisma.user.findUnique({
        where: { id },
        select: { id: true, role: { select: { isSystem: true } } },
      });
      if (!user) return reply.code(404).send({ error: "Pengguna tidak ditemukan." });
      if (user.role.isSystem) {
        return reply.code(400).send({
          error: "Akun administrator sistem tidak dapat dihapus.",
        });
      }

      await app.prisma.user.delete({ where: { id } });
      return reply.code(204).send();
    },
  );
};
