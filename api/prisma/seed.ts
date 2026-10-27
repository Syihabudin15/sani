import argon2 from "argon2";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../src/generated/prisma/client.js";

const databaseUrl = process.env.DATABASE_URL;
const username = process.env.INITIAL_ADMIN_USERNAME?.trim();
const password = process.env.INITIAL_ADMIN_PASSWORD;

if (!databaseUrl || !username || !password) {
  throw new Error(
    "DATABASE_URL, INITIAL_ADMIN_USERNAME, dan INITIAL_ADMIN_PASSWORD harus diatur untuk seed awal.",
  );
}

if (password.length < 6) {
  throw new Error("INITIAL_ADMIN_PASSWORD harus memiliki minimal 12 karakter.");
}

const menus = [
  "dashboard",
  "akumulasi",
  "distribusi",
  "smartmoney",
  "berita",
  "data-role",
  "data-pengguna",
] as const;
const actions = ["view", "create", "update", "delete"] as const;
const adapter = new PrismaMariaDb(databaseUrl);
const prisma = new PrismaClient({ adapter });

try {
  const permissions = menus.flatMap((menu) =>
    actions.map((action) => ({
      key: `${menu}:${action}`,
      menu,
      action,
      description: `${action} ${menu}`,
    })),
  );

  await prisma.permission.createMany({
    data: permissions,
    skipDuplicates: true,
  });

  const adminRole = await prisma.role.upsert({
    where: { name: "Administrator" },
    create: {
      name: "Administrator",
      description: "Akses penuh ke seluruh menu dan tindakan.",
      isSystem: true,
    },
    update: { isSystem: true },
  });

  const storedPermissions = await prisma.permission.findMany({
    select: { id: true },
  });

  await prisma.rolePermission.createMany({
    data: storedPermissions.map((permission) => ({
      roleId: adminRole.id,
      permissionId: permission.id,
    })),
    skipDuplicates: true,
  });

  const passwordHash = await argon2.hash(password);
  await prisma.user.upsert({
    where: { username },
    create: {
      username,
      passwordHash,
      isActive: true,
      roleId: adminRole.id,
    },
    update: { roleId: adminRole.id, isActive: true },
  });

  console.info(`Administrator "${username}" siap digunakan.`);
} finally {
  await prisma.$disconnect();
}
