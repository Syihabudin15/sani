export type AppConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  sessionCookieName: string;
  sessionTtlHours: number;
  secureCookies: boolean;
  signalsScanIntervalMinutes: number;
  smartMoneyScanIntervalMinutes: number;
};

function parsePort(value: string | undefined): number {
  if (!value) return 3001;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT harus berupa angka antara 1 dan 65535.");
  }

  return port;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL belum diatur. Salin .env.example ke .env lalu isi koneksi MySQL.",
    );
  }

  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL bukan URL koneksi MySQL yang valid.");
  }

  if (parsedDatabaseUrl.protocol !== "mysql:") {
    throw new Error("DATABASE_URL harus menggunakan protocol mysql://.");
  }

  const sessionTtlHours = Number(env.SESSION_TTL_HOURS ?? 12);
  if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > 720) {
    throw new Error("SESSION_TTL_HOURS harus berupa bilangan bulat antara 1 dan 720.");
  }

  const signalsScanIntervalMinutes = Number(
    env.SIGNALS_SCAN_INTERVAL_MINUTES ?? 15,
  );
  if (
    !Number.isInteger(signalsScanIntervalMinutes) ||
    signalsScanIntervalMinutes < 1 ||
    signalsScanIntervalMinutes > 720
  ) {
    throw new Error(
      "SIGNALS_SCAN_INTERVAL_MINUTES harus berupa bilangan bulat antara 1 dan 720.",
    );
  }

  const smartMoneyScanIntervalMinutes = Number(
    env.SMARTMONEY_SCAN_INTERVAL_MINUTES ?? 15,
  );
  if (
    !Number.isInteger(smartMoneyScanIntervalMinutes) ||
    smartMoneyScanIntervalMinutes < 1 ||
    smartMoneyScanIntervalMinutes > 720
  ) {
    throw new Error(
      "SMARTMONEY_SCAN_INTERVAL_MINUTES harus berupa bilangan bulat antara 1 dan 720.",
    );
  }

  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: parsePort(env.PORT),
    databaseUrl,
    sessionCookieName: env.SESSION_COOKIE_NAME?.trim() || "syrel_session",
    sessionTtlHours,
    secureCookies: env.NODE_ENV === "production",
    signalsScanIntervalMinutes,
    smartMoneyScanIntervalMinutes,
  };
}
