import type { FastifyPluginAsync } from "fastify";
import { requirePermission } from "../../plugins/auth.plugin.js";

type RoleBody = {
  name: string;
  description?: string | null;
  permissions: string[];
};

type RoleParams = { id: string };

function parseRoleId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isRoleBody(value: unknown): value is RoleBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.name === "string" &&
    body.name.trim().length > 0 &&
    body.name.trim().length <= 50 &&
    (body.description === undefined ||
      body.description === null ||
      (typeof body.description === "string" && body.description.length <= 255)) &&
    Array.isArray(body.permissions) &&
    body.permissions.every(
      (permission) => typeof permission === "string" && permission.length <= 100,
    )
  );
}

async function validatePermissions(
  app: Parameters<FastifyPluginAsync>[0],
  keys: string[],
) {
  const uniqueKeys = [...new Set(keys)];
  const permissions = await app.prisma.permission.findMany({
    where: { key: { in: uniqueKeys } },
    select: { id: true, key: true },
  });
  return permissions.length === uniqueKeys.length ? permissions : null;
}

export const registerRoleRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/roles/permissions",
    { preHandler: requirePermission("data-role:view") },
    async () =>
      app.prisma.permission.findMany({
        orderBy: [{ menu: "asc" }, { action: "asc" }],
        select: { key: true, menu: true, action: true, description: true },
      }),
  );

  app.get(
    "/roles",
    { preHandler: requirePermission("data-role:view") },
    async () =>
      app.prisma.role.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          isSystem: true,
          _count: { select: { users: true } },
          permissions: { select: { permission: { select: { key: true } } } },
        },
      }),
  );

  app.post<{ Body: RoleBody }>(
    "/roles",
    { preHandler: requirePermission("data-role:create") },
    async (request, reply) => {
      if (!isRoleBody(request.body)) {
        return reply.code(400).send({ error: "Data role tidak valid." });
      }

      const permissions = await validatePermissions(app, request.body.permissions);
      if (!permissions) {
        return reply.code(400).send({ error: "Satu atau lebih permission tidak dikenal." });
      }

      try {
        const role = await app.prisma.role.create({
          data: {
            name: request.body.name.trim(),
            description: request.body.description?.trim() || null,
            permissions: {
              create: permissions.map(({ id }) => ({ permissionId: id })),
            },
          },
          select: { id: true, name: true },
        });
        return reply.code(201).send(role);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2002"
        ) {
          return reply.code(409).send({ error: "Nama role sudah digunakan." });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: RoleParams; Body: RoleBody }>(
    "/roles/:id",
    { preHandler: requirePermission("data-role:update") },
    async (request, reply) => {
      const id = parseRoleId(request.params.id);
      if (!id || !isRoleBody(request.body)) {
        return reply.code(400).send({ error: "Data role tidak valid." });
      }

      const existing = await app.prisma.role.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Role tidak ditemukan." });
      if (existing.isSystem) {
        return reply.code(400).send({ error: "Role sistem tidak dapat diubah." });
      }

      const permissions = await validatePermissions(app, request.body.permissions);
      if (!permissions) {
        return reply.code(400).send({ error: "Satu atau lebih permission tidak dikenal." });
      }

      try {
        const role = await app.prisma.$transaction(async (transaction) => {
          await transaction.rolePermission.deleteMany({ where: { roleId: id } });
          return transaction.role.update({
            where: { id },
            data: {
              name: request.body.name.trim(),
              description: request.body.description?.trim() || null,
              permissions: {
                create: permissions.map(({ id: permissionId }) => ({
                  permissionId,
                })),
              },
            },
            select: { id: true, name: true },
          });
        });
        return role;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2002"
        ) {
          return reply.code(409).send({ error: "Nama role sudah digunakan." });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: RoleParams }>(
    "/roles/:id",
    { preHandler: requirePermission("data-role:delete") },
    async (request, reply) => {
      const id = parseRoleId(request.params.id);
      if (!id) return reply.code(400).send({ error: "ID role tidak valid." });

      const role = await app.prisma.role.findUnique({
        where: { id },
        select: { id: true, isSystem: true, _count: { select: { users: true } } },
      });
      if (!role) return reply.code(404).send({ error: "Role tidak ditemukan." });
      if (role.isSystem) {
        return reply.code(400).send({ error: "Role sistem tidak dapat dihapus." });
      }
      if (role._count.users > 0) {
        return reply.code(409).send({ error: "Role masih digunakan oleh pengguna." });
      }

      await app.prisma.role.delete({ where: { id } });
      return reply.code(204).send();
    },
  );
};
