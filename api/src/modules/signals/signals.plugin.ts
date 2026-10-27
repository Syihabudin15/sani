import fp from "fastify-plugin";
import { scanAndPersistSignals } from "./signals.service.js";

type SignalScannerOptions = {
  intervalMinutes: number;
};

export const signalScannerPlugin = fp<SignalScannerOptions>(
  async (app, options) => {
    let running = false;
    let initialTimeout: NodeJS.Timeout | undefined;
    let interval: NodeJS.Timeout | undefined;

    const runScan = async () => {
      if (running) {
        app.log.warn("Pemindaian sinyal sebelumnya belum selesai; jadwal ini dilewati.");
        return;
      }

      running = true;
      try {
        await scanAndPersistSignals(app.prisma, app.log);
      } catch (error) {
        app.log.error({ err: error }, "Pemindaian sinyal pasar gagal.");
      } finally {
        running = false;
      }
    };

    app.addHook("onReady", async () => {
      initialTimeout = setTimeout(() => void runScan(), 1_000);
      interval = setInterval(
        () => void runScan(),
        options.intervalMinutes * 60 * 1_000,
      );
      app.log.info(
        { intervalMinutes: options.intervalMinutes },
        "Pemindai sinyal pasar dijadwalkan.",
      );
    });

    app.addHook("onClose", async () => {
      if (initialTimeout) clearTimeout(initialTimeout);
      if (interval) clearInterval(interval);
    });
  },
  { name: "signal-scanner", dependencies: ["prisma"] },
);
