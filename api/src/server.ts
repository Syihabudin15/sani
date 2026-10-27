import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";

async function start() {
  let app: ReturnType<typeof buildApp> | undefined;

  try {
    const config = loadConfig();
    app = buildApp(config);
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    if (app) {
      app.log.error(error, "Gagal menjalankan server API.");
      await app.close();
    } else {
      console.error("Konfigurasi server API tidak valid.", error);
    }
    process.exitCode = 1;
  }
}

void start();
