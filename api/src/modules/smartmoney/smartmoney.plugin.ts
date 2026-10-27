import fp from "fastify-plugin";
import { scanAndPersistSmartMoney } from "./smartmoney.service.js";

type SmartMoneyScannerOptions = {
  intervalMinutes: number;
};

export const smartMoneyScannerPlugin = fp<SmartMoneyScannerOptions>(
  async (app, options) => {
    let running = false;
    let initialTimeout: NodeJS.Timeout | undefined;
    let interval: NodeJS.Timeout | undefined;

    const runScan = async () => {
      if (running) {
        app.log.warn("Pemindaian SmartMoney sebelumnya belum selesai; jadwal ini dilewati.");
        return;
      }

      running = true;
      try {
        await scanAndPersistSmartMoney(app.prisma, app.log);
      } catch (error) {
        app.log.error({ err: error }, "Pemindaian SmartMoney gagal.");
      } finally {
        running = false;
      }
    };

    app.addHook("onReady", async () => {
      initialTimeout = setTimeout(() => void runScan(), 2_000);
      interval = setInterval(
        () => void runScan(),
        options.intervalMinutes * 60 * 1_000,
      );
      app.log.info(
        { intervalMinutes: options.intervalMinutes },
        "Pemindai SmartMoney dijadwalkan.",
      );
    });

    app.addHook("onClose", async () => {
      if (initialTimeout) clearTimeout(initialTimeout);
      if (interval) clearInterval(interval);
    });
  },
  { name: "smartmoney-scanner", dependencies: ["prisma"] },
);
