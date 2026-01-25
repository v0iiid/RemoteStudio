import type { Router, Worker } from "mediasoup/types";
import { rooms, wsToPeerId, type Room } from "./index.js";
import { initWorker } from "./worker.js";
import type { types as mediasoupTypes } from "mediasoup";
import type WebSocket from "ws";

export async function createRoom(roomId: string, worker: Worker): Promise<Room> {
  const mediaCodecs: mediasoupTypes.RtpCodecCapability[] = [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
      preferredPayloadType: 100,
    },
    {
      kind: "video",
      mimeType: "video/VP8",
      clockRate: 90000,
      preferredPayloadType: 101,
    },
  ];

  const router = await worker.createRouter({ mediaCodecs });
  const room: Room = {
    id: roomId,
    router,
    peers: new Map(),
  };
  rooms.set(roomId, room);

  return room;
}

export function getRoomAndRouter(roomId: string): { room: Room; router: Router } | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  return { room, router: room.router };
}

export function cleanupPeer(socket: WebSocket, roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  const peerId = wsToPeerId.get(socket);
  if (peerId) {
    const peer = room.peers.get(peerId);

    if (peer?.producerTransport) peer.producerTransport.close();
    if (peer?.consumerTransport) peer.consumerTransport.close();

    peer?.producers.forEach((p) => p.close());
    peer?.consumers.forEach((c) => c.close());

    room.peers.delete(peerId);
    wsToPeerId.delete(socket);

    if (room.peers.size === 0) {
      room.router.close();
      rooms.delete(roomId);
    }
  }
}
