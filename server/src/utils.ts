import type { Worker } from "mediasoup/types";
import { rooms, type Room } from "./index.js";
import { initWorker } from "./worker.js";
import type { types as mediasoupTypes } from "mediasoup";

export async function createRoom(roomId:string,worker:Worker):Promise<Room> {


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

  const router = await worker.createRouter({ mediaCodecs });
  const room:Room ={
    id:roomId,
    router,
    peers:new Map()
  }
  rooms.set(roomId,room)

  return room;
}