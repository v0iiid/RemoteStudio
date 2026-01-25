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
  type WebRtcTransport,
} from "mediasoup/types";
import crypto, { randomUUID, type UUID } from "crypto";
import { cleanupPeer, createRoom, getContext, getRoomAndRouter } from "./utils.js";

export interface Peer {
  id: string;
  roomId: string;
  ws: WebSocket;

  producerTransport: WebRtcTransport | undefined;
  consumerTransport: WebRtcTransport | undefined;

  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

export interface Room {
  id: string;
  router: Router;
  peers: Map<string, Peer>;
}

export const wsToPeerId: Map<WebSocket, string> = new Map();

export const peerIdToRoomId = new Map<string, string>();

export const rooms: Map<string, Room> = new Map();

function createRoomId() {
  const roomId = crypto.randomBytes(4).toString("hex");
  console.log("room id:", roomId);
  return roomId;
}

function createPeerId(): string {
  return `peer-${randomUUID()}`;
}

async function start() {
  const server = new WebSocketServer({ port: 8081 });
  const webRtcServer = await initWebRtcServer();

  const worker = await initWorker();
  server.on("connection", async (socket) => {
    console.log("Client connected");

    socket.on("message", async (message) => {
      const data = JSON.parse(message.toString());
      console.log("type->", data.type);

      switch (data.type) {
        case "create-room": {
          const roomId = createRoomId();
          socket.send(JSON.stringify({ type: "room-created", roomId }));

          const room = await createRoom(roomId, worker);
          const peerId = createPeerId();
          const peer: Peer = {
            id: peerId,
            roomId: roomId,
            ws: socket,
            producerTransport: undefined,
            consumerTransport: undefined,
            producers: new Map(),
            consumers: new Map(),
          };
          peerIdToRoomId.set(peerId, roomId);
          room.peers.set(peerId, peer);
          rooms.set(roomId, room);
          wsToPeerId.set(socket, peerId);
          break;
        }

        case "join-room": {
          const { joinRoomId } = data;

          if (!rooms.has(joinRoomId)) {
            const newRoom = await createRoom(joinRoomId, worker);
            rooms.set(joinRoomId, newRoom);
          }
          const room = rooms.get(joinRoomId)!;

          const peerId = createPeerId();
          const peer: Peer = {
            id: peerId,
            roomId: joinRoomId,
            ws: socket,
            producerTransport: undefined,
            consumerTransport: undefined,
            producers: new Map(),
            consumers: new Map(),
          };
          room.peers.set(peerId, peer);
          peerIdToRoomId.set(peerId, room.id);
          wsToPeerId.set(socket, peerId);
          socket.send(
            JSON.stringify({
              type: "joined-room",
              joinRoomId,
              peerId,
              peerCount: room.peers.size,
            }),
          );
          break;
        }

        case "close": {
          const peerId = wsToPeerId.get(socket);
          if (!peerId) return;
          const roomId = peerIdToRoomId.get(peerId);
          if (!roomId) return;

          cleanupPeer(socket, roomId);
          break;
        }
        case "getRtpCapabilities": {
          const ctx = getContext(socket);
          if (!ctx) return;
          const { roomId } = ctx;
          if (!roomId) return;
          const data = getRoomAndRouter(roomId);
          if (!data) return;
          socket.send(
            JSON.stringify({
              type: "rtpCapabilities",
              rtpCapabilities: data.router.rtpCapabilities,
            }),
          );
          break;
        }
        case "createTransport": {
          const ctx = getContext(socket);
          if (!ctx) return;
          const { peer, router } = ctx;
          const producerTransport = await router.createWebRtcTransport({
            webRtcServer,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            enableSctp: true,
          });

          peer.producerTransport = producerTransport;
          socket.send(
            JSON.stringify({
              type: "transportCreated",
              id: producerTransport.id,
              iceParameters: producerTransport.iceParameters,
              iceCandidates: producerTransport.iceCandidates,
              dtlsParameters: producerTransport.dtlsParameters,
              sctpParameters: producerTransport.sctpParameters,
            }),
          );
          break;
        }
        case "transport-connect": {
          const ctx = getContext(socket);
          if (!ctx) return;
          const { peer } = ctx;
          const { dtlsParameters } = data;

          if (!peer?.producerTransport) return;

          await peer.producerTransport.connect({
            dtlsParameters: dtlsParameters,
          });
          break;
        }

        case "consumer-connect": {
          const ctx = getContext(socket);
          if (!ctx) return;
          const { peer } = ctx;
          const { dtlsParameters } = data;

          if (!peer?.consumerTransport) return;

          await peer.consumerTransport.connect({
            dtlsParameters: dtlsParameters,
          });
          socket.send(JSON.stringify({ type: "consumer-connected" }));
          break;
        }

        case "transport-produce": {
          const ctx = getContext(socket);
          if (!ctx) return;
          const { peer } = ctx;
          const { kind, rtpParameters, appData } = data;

          if (!peer?.producerTransport) return;

          const producer = await peer.producerTransport.produce<ProducerOptions>({
            kind: kind,
            rtpParameters: rtpParameters,
            appData: appData,
          });
          peer.producers.set(producer.id, producer);
          socket.send(
            JSON.stringify({
              type: "produce-data",
              id: producer.id,
            }),
          );
          console.log("producer-id:", producer.id);
          break;
        }
        case "create-consumerTransport": {
          const ctx = getContext(socket);
          if (!ctx) return;
          const { roomId, room, peerId, peer, router } = ctx;
          const consumerTransport = await router.createWebRtcTransport({
            webRtcServer,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            enableSctp: true,
          });
          peer.consumerTransport = consumerTransport;
          socket.send(
            JSON.stringify({
              type: "consumerTransportCreated",
              id: consumerTransport.id,
              iceParameters: consumerTransport.iceParameters,
              iceCandidates: consumerTransport.iceCandidates,
              dtlsParameters: consumerTransport.dtlsParameters,
              sctpParameters: consumerTransport.sctpParameters,
            }),
          );
          break;
        }
        case "consume": {
          const ctx = getContext(socket);
          if (!ctx) return;
          const { peer, router } = ctx;

          if (!peer || !peer.consumerTransport) return;
          const { producerId, rtpCapabilities } = data;
          if (
            !router.canConsume({
              producerId: producerId,
              rtpCapabilities: rtpCapabilities,
            })
          ) {
            console.log("the router can't consume");
            return;
          }
          console.log(
            "can it consumer",
            router.canConsume({ producerId: producerId, rtpCapabilities: rtpCapabilities }),
          );
          const consumer = await peer.consumerTransport.consume({
            producerId: producerId,
            rtpCapabilities: rtpCapabilities,
            paused: true,
          });
          peer.consumers.set(consumer.id, consumer);
          socket.send(
            JSON.stringify({
              type: "newConsumer",
              id: consumer.id,
              producerId: producerId,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
            }),
          );
          break;
        }
        case "consumer-ready": {
          const ctx = getContext(socket);
          if (!ctx) return;
          const { peer } = ctx;

          const { consumerId } = data;
          const consumer = peer.consumers.get(consumerId);
          if (!consumer) return;

          await consumer.requestKeyFrame();
          await consumer.resume();
          console.log("consumer resumed on backend");

          break;
        }
      }
    });

    socket.on("close", () => {
      const ctx = getContext(socket);
          if (!ctx) return;
          const { roomId } = ctx;
      if (!roomId) return;
      console.log("Client disconnected");
      cleanupPeer(socket, roomId);
    });
  });
}

start();
