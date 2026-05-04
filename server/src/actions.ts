import type { ProducerOptions, Router, WebRtcServer, Worker } from "mediasoup/types";
import { createPeerId, createRoomId, peerIdToRoomId, rooms, wsToPeerId, type Peer, type Room } from "./index.js";
import { cleanupPeer, createRoom, getRoomAndRouter, safeContext, sendJson } from "./utils.js";
import { registerSessionPeer } from "./recordings.js";
import type WebSocket from "ws";

export async function createNewRoom(worker: Worker) {
  const roomId = createRoomId();
  await createRoom(roomId, worker);
  return roomId;
}

export async function joinRoom(payload: any, socket: WebSocket) {
  const { joinRoomId, hostToken } = payload;
  if (!rooms.has(joinRoomId)) {
    sendJson(socket, {
      type: "room-not-found",
    });
    return;
  }

  const room = rooms.get(joinRoomId)!;
  const peerId = createPeerId();
  const sessionPeer = registerSessionPeer(joinRoomId, peerId, hostToken);
  const peer: Peer = {
    id: peerId,
    roomId: joinRoomId,
    ws: socket,
    isHost: sessionPeer.isHost,
    producerTransport: undefined,
    consumerTransport: undefined,
    consumerTransportConnected: false,
    producers: new Map(),
    consumers: new Map(),
  };
  room.peers.set(peerId, peer);
  peerIdToRoomId.set(peerId, room.id);
  wsToPeerId.set(socket, peerId);
  const existingPeerIds = [...room.peers.keys()].filter((id) => id !== peerId);
  const existingProducerIds = existingPeerIds.flatMap((existingId) => {
    const existingPeer = room.peers.get(existingId);
    if (!existingPeer) return [];
    return [...existingPeer.producers.keys()];
  });

  sendJson(socket, {
    type: "joined-room",
    payload: {
      joinRoomId,
      peerId,
      existingPeerIds,
      existingProducerIds,
      isHost: sessionPeer.isHost,
      uploadToken: sessionPeer.uploadToken,
    },
  });

  for (const existingPeerId of existingPeerIds) {
    const existingPeer = room.peers.get(existingPeerId);
    if (!existingPeer) continue;

    sendJson(existingPeer.ws, {
      type: "peer-joined",
      payload: { peerId },
    });
  }
}

export function close(socket: WebSocket) {
  const peerId = wsToPeerId.get(socket);
  if (!peerId) return;
  const roomId = peerIdToRoomId.get(peerId);
  if (!roomId) return;

  cleanupPeer(socket, roomId);
}

export function getRtpCapabilities(socket: WebSocket) {
  const { roomId, peer } = safeContext(socket);
  if (!roomId) return;
  const data = getRoomAndRouter(roomId);
  if (!data) return;
  peer.rtpCapabilities = data.router.rtpCapabilities;
  sendJson(socket, {
    type: "rtpCapabilities",
    payload: { rtpCapabilities: data.router.rtpCapabilities },
  });
  if (data.router.rtpCapabilities) {
    peer.rtpCapabilities = data.router.rtpCapabilities;
  }
}

export async function createProducerTransport(webRtcServer: WebRtcServer, socket: WebSocket) {
  const { peer, router } = safeContext(socket);

  const producerTransport = await router.createWebRtcTransport({
    webRtcServer,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    enableSctp: true,
  });

  peer.producerTransport = producerTransport;
  sendJson(socket, {
    type: "transportCreated",
    payload: {
      id: producerTransport.id,
      iceParameters: producerTransport.iceParameters,
      iceCandidates: producerTransport.iceCandidates,
      dtlsParameters: producerTransport.dtlsParameters,
      sctpParameters: producerTransport.sctpParameters,
    },
  });
}
export async function producerTransportConnect(payload: any, socket: WebSocket) {
  const { peer } = safeContext(socket);
  const { dtlsParameters } = payload;
  if (!peer?.producerTransport) return;

  await peer.producerTransport.connect({
    dtlsParameters: dtlsParameters,
  });
}

export async function consumerConnect(payload: any, socket: WebSocket) {
  const { peer, room, router } = safeContext(socket);
  const { dtlsParameters } = payload;

  if (!peer?.consumerTransport) return;

  await peer.consumerTransport.connect({
    dtlsParameters: dtlsParameters,
  });
  peer.consumerTransportConnected = true;

  sendJson(socket, { type: "consumer-connected" });
  console.log("consumer connected01->",peer.rtpCapabilities)
  if (peer.rtpCapabilities) {
    console.log("consumer connected->")
    await createConsumersForExistingProducers(peer, room, router);
  }
}

export async function transportProduce(payload: any, socket: WebSocket) {
  const { peer, room, router } = safeContext(socket);

  if (!peer.producerTransport || !peer.consumerTransport) return;

  const { kind, rtpParameters, appData } = payload;

  const producer = await peer.producerTransport.produce<ProducerOptions>({
    kind,
    rtpParameters,
    appData: { ...appData, producerId: peer.id },
  });

  peer.producers.set(producer.id, producer);

  sendJson(socket, {
    type: "produce-data",
    payload: { id: producer.id },
  });
  for (const [otherPeerId, otherPeer] of room.peers) {
    if (otherPeerId == peer.id) continue;
    if (!otherPeer.consumerTransport) continue;
    if (!router.canConsume({ producerId: producer.id, rtpCapabilities: otherPeer.rtpCapabilities })) continue;
    const existing = Array.from(otherPeer.consumers.values()).find((c) => c.appData?.producerId === producer.id);
    if (existing) continue;

    const consumer = await otherPeer.consumerTransport.consume({
      producerId: producer.id,
      rtpCapabilities: otherPeer.rtpCapabilities,
      paused: true,
      appData: { producerId: producer.id },
    });
    console.log("--------->new conusmer by transportProduce ",consumer.kind);
    sendJson(otherPeer.ws, {
      type: "newConsumer",
      payload: {
        id: consumer.id,
        producerId: producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      },
    });
    otherPeer.consumers.set(consumer.id, consumer);
  }
  console.log("producer-id:", producer.id);
}

export async function createConsumerTransport(webRtcServer: WebRtcServer, socket: WebSocket) {
  const { peer, room, router } = safeContext(socket);

  const consumerTransport = await router.createWebRtcTransport({
    webRtcServer,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    enableSctp: true,
  });

  peer.consumerTransport = consumerTransport;

  sendJson(socket, {
    type: "consumerTransportCreated",
    payload: {
      id: consumerTransport.id,
      iceParameters: consumerTransport.iceParameters,
      iceCandidates: consumerTransport.iceCandidates,
      dtlsParameters: consumerTransport.dtlsParameters,
      sctpParameters: consumerTransport.sctpParameters,
    },
  });
}

export async function consumerReady(payload: any, socket: WebSocket) {
  const { peer } = safeContext(socket);

  const { consumerId } = payload;
  const consumer = peer.consumers.get(consumerId);
  if (!consumer) return;
  await consumer.requestKeyFrame();
  await consumer.resume();
  console.log("consumer resumed on backend");
}
async function createConsumersForExistingProducers(newPeer: Peer, room: Room, router: Router) {
  console.log("going for existing")
  if (!newPeer.consumerTransport) return;
  console.log("going for existing 2")
  for (const otherPeer of room.peers.values()) {
    if (otherPeer.id === newPeer.id) continue;

    for (const producer of otherPeer.producers.values()) {
      const alreadyConsuming = Array.from(newPeer.consumers.values()).find(
        (c) => c.appData?.producerId === producer.id,
      );
      if (alreadyConsuming) continue;

      if (
        !router.canConsume({
          producerId: producer.id,
          rtpCapabilities: newPeer.rtpCapabilities,
        })
      )
        continue;
        console.log("going for existing consumer")
      const consumer = await newPeer.consumerTransport.consume({
        producerId: producer.id,
        rtpCapabilities: newPeer.rtpCapabilities,
        paused: true,
        appData: { producerId: producer.id },
      });
      console.log("creating consuemr for exsiting producers")
      newPeer.consumers.set(consumer.id, consumer);

      sendJson(newPeer.ws, {
        type: "newConsumer",
        payload: {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        },
      });
    }
  }
}

export async function consumerReadyForConsume(socket: WebSocket) {
  const { peer, room, router } = safeContext(socket);

  if (!peer.consumerTransport) return;
  if (!peer.rtpCapabilities) return;

  await createConsumersForExistingProducers(peer, room, router);
}
