import express from "express";
import { initWebRtcServer, initWorker } from "./worker.js";
import https from "https";
import cors from "cors"
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
import fs from "fs"
import path from "path";
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

const options = {
  key: fs.readFileSync("./ssl/key.pem"),
  cert: fs.readFileSync("./ssl/cert.pem"),
};

const app = express();

app.use(express.json());
app.use(cors({
  origin: ['https://10.200.30.193:3000','http://localhost:3000'],
  credentials: true,
}));

app.post("/api/createRoom", async(req, res) => {
  console.log("in create rom")
  const roomId =await createNewRoom(worker);
  console.log("roomId",roomId)
  res.status(200).json({ roomId });
});

app.post("/api/joinRoom", (req, res) => {
  const { roomId } = req.body;
  if (!rooms.has(roomId)) {
    return res.status(404).json({ error: "Room not found" });
  }
  res.status(200).json({ success: true });
});

app.get("/api/rooms/:roomId",(req,res)=>{
    const { roomId } = req.params;
    console.log("roomId",roomId)
    if (!rooms.has(roomId as string)) {
    return res.status(404).json({ exists: false });
  }
  return res.status(200).json({ exists: true });
})

const httpServer = https.createServer(options,app);

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

httpServer.listen(8000,"0.0.0.0", () => {
  console.log("Sever running on port 8000");
});
