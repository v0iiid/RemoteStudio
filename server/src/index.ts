import express from "express";
import { initRouter, initWebRtcServer } from "./worker.js";
import { WebSocketServer } from "ws";

async function start() {
  const server = new WebSocketServer({ port: 8081 });
  const router = await initRouter();
  server.on("connection", async(socket) => {
    console.log("Client connected");
      const transport = await router.createWebRtcTransport({
            webRtcServer,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            enableSctp: true,
          });
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
          break;
        case "transport-connect":

          await transport.connect({
            dtlsParameters: {
              role: "server",
              fingerprints: [
                {
                  algorithm: "sha-256",
                  value:
                    "E5:F5:CA:A7:2D:93:E6:16:AC:21:09:9F:23:51:62:8C:D0:66:E9:0C:22:54:2B:82:0C:DF:E0:C5:2C:7E:CD:53",
                },
              ],
            },
          });
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
