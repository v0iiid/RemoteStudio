import * as mediasoup from "mediasoup";
import type { types as mediasoupTypes } from "mediasoup";
import { rooms, type Room } from "./index.js";

let worker: mediasoupTypes.Worker;
let router: mediasoupTypes.Router;

export async function initWorker() {
  worker = await mediasoup.createWorker({
    rtcMinPort: 10000,
    rtcMaxPort: 59999,
    logLevel: "error",
  });

  console.log("mediasoup worker pid:", worker.pid);

  worker.on("died", (error) => {
    console.error("mediasoup worker died!: %o", error);
  });

  return worker;
}

export async function initWebRtcServer() {
  if (!worker) {
    await initWorker();
  }
  const webRtcServer = await worker.createWebRtcServer({
    listenInfos: [
      {
        protocol: "udp",
        ip: "0.0.0.0",
        announcedIp: "127.0.0.1",
        port: 20005,
      },
      {
        protocol: "tcp",
        ip: "0.0.0.0",
        announcedIp: "127.0.0.1",
        port: 20005,
      },
    ],
  });
  return webRtcServer;
}


