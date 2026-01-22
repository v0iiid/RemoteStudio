import express from "express";
import { initRouter, initWebRtcServer } from "./worker.js";
import { WebSocketServer } from "ws";

async function start() {
  const server = new WebSocketServer({ port: 8081 });
  const router = await initRouter();
  server.on("connection", (socket) => {
    console.log("Client connected");
    socket.on("message", async (message) => {
      const data = JSON.parse(message.toString());

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
          const transport = await router.createWebRtcTransport({
            webRtcServer,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            enableSctp: true,
          });
          socket.send(
            JSON.stringify({
              type: "transportCreated",
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
              sctpParameters: transport.sctpParameters,
            }),
          );
      }
    });

    socket.on("close", () => {
      console.log("Client disconnected");
    });
  });

  const webRtcServer = await initWebRtcServer();
  console.log(router.id);
  const transport = await router.createWebRtcTransport({
    webRtcServer,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    enableSctp: true,
  });
}

start();
