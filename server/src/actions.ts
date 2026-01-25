import type { ProducerOptions, WebRtcServer, Worker } from "mediasoup/types";
import { createPeerId, createRoomId, peerIdToRoomId, rooms, wsToPeerId, type Peer } from "./index.js";
import { cleanupPeer, createRoom, getRoomAndRouter, safeContext, sendJson } from "./utils.js";
import type WebSocket from "ws";

export async function joinRoom(data: any, worker: Worker, socket: WebSocket) {
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
  sendJson(socket, {
    type: "joined-room",
    joinRoomId,
    peerId,
    peerCount: room.peers.size,
  });
}

export async function createNewRoom(data: any, worker: Worker, socket: WebSocket) {
  const roomId = createRoomId();
  sendJson(socket, { type: "room-created", roomId });

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
}

export function close(data: any, worker: Worker, socket: WebSocket) {
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
  sendJson(socket, {
    type: "rtpCapabilities",
    rtpCapabilities: data.router.rtpCapabilities,
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
    id: producerTransport.id,
    iceParameters: producerTransport.iceParameters,
    iceCandidates: producerTransport.iceCandidates,
    dtlsParameters: producerTransport.dtlsParameters,
    sctpParameters: producerTransport.sctpParameters,
  });
}
export async function producerTransportConnect(data: any, socket: WebSocket) {
  const { peer } = safeContext(socket);
  const { dtlsParameters } = data;

  if (!peer?.producerTransport) return;

  await peer.producerTransport.connect({
    dtlsParameters: dtlsParameters,
  });
}

export async function consumerConnect(data: any, socket: WebSocket) {
  const { peer } = safeContext(socket);
  const { dtlsParameters } = data;

  if (!peer?.consumerTransport) return;

  await peer.consumerTransport.connect({
    dtlsParameters: dtlsParameters,
  });
  sendJson(socket, { type: "consumer-connected" });
}

export async function transportProduce(data: any, socket: WebSocket) {
  const { peer, room, router } = safeContext(socket);

  const { kind, rtpParameters, appData } = data;

  if (!peer?.producerTransport) return;

  const producer = await peer.producerTransport.produce<ProducerOptions>({
    kind: kind,
    rtpParameters: rtpParameters,
    appData: appData,
  });
  peer.producers.set(producer.id, producer);
  sendJson(socket, {
    type: "produce-data",
    id: producer.id,
  });

  console.log("producer-id:", producer.id);

  for (const [otherPeerId, otherPeer] of room.peers) {
    if (otherPeerId == peer.id) continue;
    if (!otherPeer.consumerTransport) continue;

    const { rtpCapabilities } = otherPeer;
    if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) continue;

    const consumer = await otherPeer.consumerTransport.consume({
      producerId: producer.id,
      rtpCapabilities: rtpCapabilities,
    });
    sendJson(otherPeer.ws, {
      type: "newConsumer",
      id: consumer.id,
      producerId: producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });
  }
}
export async function createConsumerTransport(webRtcServer: WebRtcServer, socket: WebSocket) {
  const { peer, router } = safeContext(socket);
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
    id: consumerTransport.id,
    iceParameters: consumerTransport.iceParameters,
    iceCandidates: consumerTransport.iceCandidates,
    dtlsParameters: consumerTransport.dtlsParameters,
    sctpParameters: consumerTransport.sctpParameters,
  });
}

export async function consume(data: any, socket: WebSocket) {
  const { peer, router } = safeContext(socket);

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
  console.log("can it consumer", router.canConsume({ producerId: producerId, rtpCapabilities: rtpCapabilities }));
  const consumer = await peer.consumerTransport.consume({
    producerId: producerId,
    rtpCapabilities: rtpCapabilities,
    paused: true,
  });
  peer.consumers.set(consumer.id, consumer);
  sendJson(socket, {
    type: "newConsumer",
    id: consumer.id,
    producerId: producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  });
}
export async function consumerReady(data: any, socket: WebSocket) {
  const { peer } = safeContext(socket);

  const { consumerId } = data;
  const consumer = peer.consumers.get(consumerId);
  if (!consumer) return;

  await consumer.requestKeyFrame();
  await consumer.resume();
  console.log("consumer resumed on backend");
}
