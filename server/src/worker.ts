import * as mediasoup from "mediasoup";
import type { types as mediasoupTypes } from "mediasoup";

let worker: mediasoupTypes.Worker;
let router: mediasoupTypes.Router;

export async function initWorker() {
  worker = await mediasoup.createWorker({
    rtcMinPort: 10000,
    rtcMaxPort: 59999,
    logLevel: "error"
  });

  console.log("mediasoup worker pid:", worker.pid);

  worker.on("died", (error) => {
    console.error("mediasoup worker died!: %o", error);
  });

  return worker;
}

export async function initRouter() {
  if (!worker) {
    await initWorker();
  }

  const mediaCodecs: mediasoupTypes.RtpCodecCapability[] = [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
        preferredPayloadType: 100
    },
    {
      kind: "video",
      mimeType: "video/VP8",
      clockRate: 90000,
        preferredPayloadType: 101
    }
  ];

  router = await worker.createRouter({ mediaCodecs });
  return router;
}

export async function initWebRtcServer() {
   if (!worker) {
    await initWorker();
  }
  const webRtcServer = await worker.createWebRtcServer(
  {
    listenInfos :
    [
      {
        protocol : 'udp',
        ip       : '0.0.0.0',
        port     : 20005
      },
      {
        protocol : 'tcp',
        ip       : '0.0.0.0',
        port     : 20005
      }
    ]
  });
  return webRtcServer;
}
