import express from "express";
import {initRouter, initWebRtcServer} from "./worker.js"
const app = express();
const PORT = 5000;


async function start() {


  const router = await initRouter();
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
