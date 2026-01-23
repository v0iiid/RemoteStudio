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

        case "consumer-connect":
          console.log("consumer connnect");
          await consumerTransport.connect({
            dtlsParameters: data.data.dtlsParameters,
          });
          socket.send(JSON.stringify({type:"consumer-connected"}))
          break;
        case "consume":
          console.log("consumer_>", data);
          if (router.canConsume({ producerId: data.data.id, rtpCapabilities: data.data.rtpCapabilities })) {
            consumer = await consumerTransport.consume({
              producerId: data.data.id,
              rtpCapabilities: data.data.rtpCapabilities,
            });
            socket.send(
              JSON.stringify({
                type: "newConsumer",
                id: consumer.id,
                producerId: data.data.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
              }),
            );
          } else {
            console.log("error at consumer");
            return;
          }

          break;
          case "resume-consumer":
            consumer.resume();
            socket.send(JSON.stringify({
              type:"consumer-resumed"
            }))
      }
    });

    socket.on("close", () => {
      console.log("Client disconnected");
    });
  });

  console.log(router.id);
}

start();
