import express from "express";
import { initRouter, initWebRtcServer } from "./worker.js";
import { WebSocketServer } from "ws";
import {
  type Consumer,
  type ConsumerOptions,
  type Producer,
  type ProducerOptions,
  type Transport,
  type WebRtcTransport,
} from "mediasoup/types";
import crypto from "crypto";

const rooms = new Map();

function createRoomId() {
  const roomId = crypto.randomBytes(4).toString("hex");
  console.log("room id:", roomId);
  return roomId;
}

async function start() {
  const server = new WebSocketServer({ port: 8081 });
  const webRtcServer = await initWebRtcServer();
  const router = await initRouter();
  server.on("connection", async (socket) => {
    console.log("Client connected");
    let producerTransport: WebRtcTransport;
    let consumerTransport: WebRtcTransport;
    let producer: Producer;
    let consumer: Consumer;
    socket.on("message", async (message) => {
      const data = JSON.parse(message.toString());
      console.log("type->", data.type);

      switch (data.type) {
        case "create-room":
          const roomId = createRoomId();
          socket.send(JSON.stringify({type:"room-created",roomId}))
          rooms.set(roomId,{
            peers:new Set()
          })
          break;

        case "getRtpCapabilities":
          socket.send(
            JSON.stringify({
              type: "rtpCapabilities",
              rtpCapabilities: router.rtpCapabilities,
            }),
          );
          break;
        case "createTransport":
          producerTransport = await router.createWebRtcTransport({
            webRtcServer,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            enableSctp: true,
          });
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
        case "transport-connect":
          await producerTransport.connect({
            dtlsParameters: data.data.dtlsParameters,
          });
          break;
        case "consumer-connect":
          await consumerTransport.connect({
            dtlsParameters: data.data.dtlsParameters,
          });
          socket.send(JSON.stringify({ type: "consumer-connected" }));
          break;
        case "transport-produce":
          producer = await producerTransport.produce<ProducerOptions>({
            kind: data.data.kind,
            rtpParameters: data.data.rtpParameters,
            appData: data.data.appData,
          });
          socket.send(
            JSON.stringify({
              type: "produce-data",
              id: producer.id,
            }),
          );
          console.log("producer-id:", producer.id);
          break;
        case "create-consumerTransport":
          consumerTransport = await router.createWebRtcTransport({
            webRtcServer,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            enableSctp: true,
          });
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

        case "consume":
          if (!producer || !consumerTransport) return;

          if (
            !router.canConsume({
              producerId: producer.id,
              rtpCapabilities: data.data.rtpCapabilities,
            })
          ) {
            console.log("the router can't consume");
            return;
          }
          console.log(
            "can it consumer",
            router.canConsume({ producerId: producer.id, rtpCapabilities: data.data.rtpCapabilities }),
          );
          consumer = await consumerTransport.consume({
            producerId: producer.id,
            rtpCapabilities: data.data.rtpCapabilities,
            paused: true,
          });

          socket.send(
            JSON.stringify({
              type: "newConsumer",
              id: consumer.id,
              producerId: producer.id,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
            }),
          );
          break;

        case "consumer-ready":
          console.log("is consumer-ready");
          if (consumer) {
            await consumer.requestKeyFrame();
            await consumer.resume();
            console.log("consumer resumed on backend");
          }
      }
    });

    socket.on("close", () => {
      console.log("Client disconnected");
    });
  });

  console.log(router.id);
}

start();
