import express from "express";
import { initRouter, initWebRtcServer } from "./worker.js";
import { WebSocketServer } from "ws";
import { type Consumer, type ConsumerOptions, type Producer, type ProducerOptions, type Transport, type WebRtcTransport } from "mediasoup/types";

async function start() {
  const server = new WebSocketServer({ port: 8081 });
  const webRtcServer = await initWebRtcServer();
  const router = await initRouter();
  server.on("connection", async (socket) => {
    console.log("Client connected");
    let producerTransport: WebRtcTransport;
    let consumerTransport: Consumer;
    socket.on("message", async (message) => {
      const data = JSON.parse(message.toString());
      console.log("type->", data.type);

      switch (data.type) {
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
          console.log("dtls->", data.data);
          await producerTransport.connect({
            dtlsParameters: data.data.dtlsParameters,
          });

          break;
        case "transport-produce":
          const producer = await producerTransport.produce<ProducerOptions>({
            id: data.id,
            kind: data.kind,
            rtpParameters: data.rtpParameters,
            appData: data.appData,
          });
          socket.send(
            JSON.stringify({
              type: "produce-data",
              id: producer.id,
            }),
          );
          console.log("producer-id:", producer.id);
          break;
        case "create-consumer":

          socket.send(
            JSON.stringify({
              type: "consumerCreated",
              id: consumer.id,
            }),
          );

          break;
      }
    });

    socket.on("close", () => {
      console.log("Client disconnected");
    });
  });

  console.log(router.id);
}

start();
