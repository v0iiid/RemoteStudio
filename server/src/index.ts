import express from "express";
import { initWebRtcServer, initWorker } from "./worker.js";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import {
  type Consumer,
  type ConsumerOptions,
  type Producer,
  type ProducerOptions,
  type Router,
  type Transport,
  type WebRtcServer,
  type WebRtcTransport,
} from "mediasoup/types";
import crypto, { randomUUID, type UUID } from "crypto";
import { cleanupPeer, createRoom, getRoomAndRouter, safeContext, sendJson } from "./utils.js";
import {
  close,
  consume,
  consumerConnect,
  consumerReady,
  createConsumerTransport,
  createNewRoom,
  createProducerTransport,
  getRtpCapabilities,
  joinRoom,
  producerTransportConnect,
  transportProduce,
} from "./actions.js";
import type { ClientToServerMessage } from "./type.js";

export interface Peer {
  id: string;
  roomId: string;
  ws: WebSocket;

  producerTransport: WebRtcTransport | undefined;
  consumerTransport: WebRtcTransport | undefined;

  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
  rtpCapabilities?: any;
}

export interface Room {
  id: string;
  router: Router;
  peers: Map<string, Peer>;
}

export const wsToPeerId: Map<WebSocket, string> = new Map();

export const peerIdToRoomId = new Map<string, string>();

export const rooms: Map<string, Room> = new Map();

export function createRoomId() {
  const roomId = crypto.randomBytes(4).toString("hex");
  console.log("room id:", roomId);
  return roomId;
}

export function createPeerId(): string {
  return `peer-${randomUUID()}`;
}
let webRtcServer: WebRtcServer;
const worker = await initWorker();

const app = express();

app.use(express.json());

app.post("/api/create-room", (req, res) => {
  const roomId = createNewRoom(worker);
  res.status(200).json({ roomId });
});

app.post("/api/joinRoom", (req, res) => {
  const { roomId } = req.body;
  if (!rooms.has(roomId)) {
    return res.status(404).json({ error: "Room not found" });
  }
  res.status(200).json({ success: true });
});

const httpServer = http.createServer(app);

const wss = new WebSocketServer({ server:httpServer });

webRtcServer = await initWebRtcServer();

wss.on("connection", async (socket) => {
  console.log("Client connected");

  socket.on("message", async (message) => {
    const parsed: ClientToServerMessage = JSON.parse(message.toString());
    console.log("type->", parsed.type);

    switch (parsed.type) {

      case "join-room": {
        joinRoom(parsed.payload, socket);
        break;
      }

      case "close-room": {
        close(socket);

        break;
      }
      case "getRtpCapabilities": {
        getRtpCapabilities(socket);

        break;
      }
      case "createTransport": {
        createProducerTransport(webRtcServer, socket);
        break;
      }
      case "transport-connect": {
        producerTransportConnect(parsed.payload, socket);
        break;
      }

      case "consumer-connect": {
        console.log("consumer connected");
        consumerConnect(parsed.payload, socket);
        break;
      }

      case "transport-produce": {
        transportProduce(parsed.payload, socket);
        break;
      }
      case "create-consumerTransport": {
        createConsumerTransport(webRtcServer, socket);
        break;
      }
      case "consume": {
        consume(parsed.payload, socket);
        break;
      }
      case "consumer-ready": {
        consumerReady(parsed.payload, socket);
        break;
      }
    }
  });

  socket.on("close", () => {
    const { roomId } = safeContext(socket);
    if (!roomId) return;
    console.log("Client disconnected");
    cleanupPeer(socket, roomId);
  });
});

httpServer.listen(8080, () => {
  console.log("Sever running on port 5000");
});
