import * as mediasoup from "mediasoup";
import type { types as mediasoupTypes } from "mediasoup";

let worker: mediasoupTypes.Worker;
let router: mediasoupTypes.Router;

export async function initWorker() {
  if (!worker) {
    worker = await mediasoup.createWorker({
      rtcMinPort: 10000,
      rtcMaxPort: 59999,
      logLevel: "error",
    });

    console.log("mediasoup worker pid:", worker.pid);

    worker.on("died", (error) => {
      console.error("mediasoup worker died!: %o", error);
    });
  }

  return worker;
}

export async function initWebRtcServer() {
  const currentWorker = await initWorker();

  const webRtcServer = await currentWorker.createWebRtcServer({
    listenInfos: [
      {
        protocol: "udp",
        ip: "0.0.0.0",
        announcedIp: "10.200.30.193",
        port: 20005,
      },
      {
        protocol: "tcp",
        ip: "0.0.0.0",
        announcedIp: "10.200.30.193",
        port: 20005,
      },
    ],
  });
  return webRtcServer;
}
