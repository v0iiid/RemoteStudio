
import express from "express";
import {initRouter} from "./worker.js"
const app = express();
const PORT = 5000;

async function start() {

  app.get("/", (_req, res) => {
    res.send("hello");
  });
  const router = await initRouter();
  console.log(router.id);
  app.listen(PORT, () => {
    console.log("port", PORT);
  });
}


start();
