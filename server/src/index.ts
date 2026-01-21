import express from "express";
import {initRouter, initWebRtcServer} from "./worker.js"
import { WebSocketServer } from "ws";


async function start() {

  const server = new WebSocketServer({ port: 8080 });
    const router = await initRouter();
  server.on('connection', socket => {
  console.log('Client connected');
    console.log(router.rtpCapabilities);
  socket.on('message', message => {
    const data = JSON.parse(message.toString());
    switch(data.type){
      case "rtpCapabilities":
        socket.send(JSON.stringify({
          type:"rtpCapabilities",
          rtpCapabilities:router.rtpCapabilities
        }))

    }
    console.log(`Received: ${message}`);
    // Echo the message back
    socket.send(`Server says: ${message}`);
  });

  socket.on('close', () => {
    console.log('Client disconnected');
  });
});

  const webRtcServer =await initWebRtcServer();
  console.log(router.id);
  const producer = await router.createWebRtcTransport(
    {
    webRtcServer : webRtcServer,
    enableUdp    : true,
    enableTcp    : false
    });
const consumer = await router.createWebRtcTransport(
  {
    webRtcServer : webRtcServer,
    enableUdp    : true,
    enableTcp    : false
  });

}


start();
