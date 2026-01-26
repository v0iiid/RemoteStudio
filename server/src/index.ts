import express from "express";
import { initWebRtcServer, initWorker } from "./worker.js";
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
async function start() {
  const server = new WebSocketServer({ port: 8081 });
  webRtcServer = await initWebRtcServer();

  const worker = await initWorker();
  console.log("ran tim1")
  server.on("connection", async (socket) => {
    console.log("Client connected");

    socket.on("message", async (message) => {
      const parsed:ClientToServerMessage = JSON.parse(message.toString());
      console.log("type->", parsed.type);

      switch (parsed.type) {
        case "create-room": {
          createNewRoom( worker, socket);
          break;
        }

        case "join-room": {
          console.log("join room",parsed)
          joinRoom(parsed.payload, socket);
          break;
        }

        case 'close-room': {
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
}

start();
