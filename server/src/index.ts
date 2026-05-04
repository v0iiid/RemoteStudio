import express from "express";
import fs from "fs";
import { initWebRtcServer, initWorker } from "./worker.js";
import https from "https";
import cors from "cors";
import WebSocket, { WebSocketServer } from "ws";
import {
  type Consumer,
  type Producer,
  type Router,
  type WebRtcServer,
  type WebRtcTransport,
} from "mediasoup/types";
import crypto, { randomUUID } from "crypto";
import { cleanupPeer, safeContext } from "./utils.js";
import {
  close,
  consumerConnect,
  consumerReady,
  consumerReadyForConsume,
  createConsumerTransport,
  createNewRoom,
  createProducerTransport,
  getRtpCapabilities,
  joinRoom,
  producerTransportConnect,
  transportProduce,
} from "./actions.js";
import { serverConfig } from "./config.js";
import {
  createRoomHostAccess,
  getRecordingForDownload,
  listRoomRecordings,
  openRecordingDownloadStream,
  finalizeRecordingUpload,
  startRecordingUploadSession,
  storeRecordingChunk,
  storeUploadedRecording,
} from "./recordings.js";
import type { ClientToServerMessage } from "./type.js";

export interface Peer {
  id: string;
  roomId: string;
  ws: WebSocket;
  isHost: boolean;

  producerTransport: WebRtcTransport | undefined;
  consumerTransport: WebRtcTransport | undefined;
  consumerTransportConnected: boolean;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
  rtpCapabilities?: any;
}

export interface Room {
  id: string;
  router: Router;
  peers: Map<string, Peer>;
}

export const wsToPeerId: Map<WebSocket, string> = new Map();

export const peerIdToRoomId = new Map<string, string>();

export const rooms: Map<string, Room> = new Map();

export function createRoomId() {
  const roomId = crypto.randomBytes(4).toString("hex");
  console.log("room id:", roomId);
  return roomId;
}

export function createPeerId(): string {
  return `peer-${randomUUID()}`;
}
let webRtcServer: WebRtcServer;
const worker = await initWorker();

const options = {
  key: fs.readFileSync(serverConfig.sslKeyPath),
  cert: fs.readFileSync(serverConfig.sslCertPath),
};

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: serverConfig.corsOrigins,
    credentials: true,
  }),
);

app.post("/api/createRoom", async (req, res) => {
  const roomId = await createNewRoom(worker);
  const hostAccess = createRoomHostAccess(roomId);

  res.status(200).json(hostAccess);
});

app.post("/api/joinRoom", (req, res) => {
  const { roomId } = req.body;
  if (!rooms.has(roomId)) {
    return res.status(404).json({ error: "Room not found" });
  }
  res.status(200).json({ success: true });
});

app.get("/api/rooms/:roomId", (req, res) => {
  const { roomId } = req.params;

  if (!rooms.has(roomId as string)) {
    return res.status(404).json({ exists: false });
  }
  return res.status(200).json({ exists: true });
});

app.put("/api/rooms/:roomId/recordings/:peerId", async (req, res) => {
  const { roomId, peerId } = req.params;

  try {
    const recording = await storeUploadedRecording({
      roomId,
      peerId,
      uploadToken: req.header("x-recording-token"),
      mimeType: req.header("x-recording-mime-type") || undefined,
      durationSeconds: Number(req.header("x-recording-duration-seconds") || "0"),
      request: req,
    });

    return res.status(200).json({
      recording: {
        id: recording.id,
        peerId: recording.peerId,
        role: recording.role,
        fileName: recording.fileName,
        mimeType: recording.mimeType,
        size: recording.size,
        durationSeconds: recording.durationSeconds,
        uploadedAt: recording.uploadedAt,
      },
    });
  } catch (error) {
    console.error("recording upload failed", error);

    if (error instanceof Error) {
      if (error.message === "ROOM_SESSION_NOT_FOUND") {
        return res.status(404).json({ error: "Room session not found" });
      }

      if (error.message === "UPLOAD_ACCESS_DENIED") {
        return res.status(403).json({ error: "Upload access denied" });
      }
    }

    return res.status(500).json({ error: "Recording upload failed" });
  }
});

app.post("/api/rooms/:roomId/recordings/:peerId/upload-session", async (req, res) => {
  const { roomId, peerId } = req.params;

  try {
    const uploadSession = await startRecordingUploadSession({
      roomId,
      peerId,
      uploadToken: req.header("x-recording-token"),
      mimeType: req.body?.mimeType,
    });

    return res.status(200).json(uploadSession);
  } catch (error) {
    console.error("recording upload session start failed", error);

    if (error instanceof Error) {
      if (error.message === "ROOM_SESSION_NOT_FOUND") {
        return res.status(404).json({ error: "Room session not found" });
      }

      if (error.message === "UPLOAD_ACCESS_DENIED") {
        return res.status(403).json({ error: "Upload access denied" });
      }
    }

    return res.status(500).json({ error: "Unable to start recording upload session" });
  }
});

app.put(
  "/api/rooms/:roomId/recordings/:peerId/upload-session/:uploadSessionId/chunks/:chunkIndex",
  async (req, res) => {
    const { roomId, peerId, uploadSessionId, chunkIndex } = req.params;

    try {
      const storedChunk = await storeRecordingChunk({
        roomId,
        peerId,
        uploadSessionId,
        uploadToken: req.header("x-recording-token"),
        chunkIndex: Number(chunkIndex),
        request: req,
      });

      return res.status(200).json(storedChunk);
    } catch (error) {
      console.error("recording chunk upload failed", error);

      if (error instanceof Error) {
        if (error.message === "ROOM_SESSION_NOT_FOUND") {
          return res.status(404).json({ error: "Room session not found" });
        }

        if (error.message === "UPLOAD_ACCESS_DENIED") {
          return res.status(403).json({ error: "Upload access denied" });
        }

        if (
          error.message === "UPLOAD_SESSION_NOT_FOUND" ||
          error.message === "UPLOAD_SESSION_MISMATCH"
        ) {
          return res.status(404).json({ error: "Upload session not found" });
        }

        if (error.message === "INVALID_CHUNK_INDEX") {
          return res.status(400).json({ error: "Invalid chunk index" });
        }
      }

      return res.status(500).json({ error: "Recording chunk upload failed" });
    }
  }
);

app.post(
  "/api/rooms/:roomId/recordings/:peerId/upload-session/:uploadSessionId/finalize",
  async (req, res) => {
    const { roomId, peerId, uploadSessionId } = req.params;

    try {
      const recording = await finalizeRecordingUpload({
        roomId,
        peerId,
        uploadSessionId,
        uploadToken: req.header("x-recording-token"),
        totalChunks: Number(req.body?.totalChunks),
        durationSeconds: Number(req.body?.durationSeconds || "0"),
      });

      return res.status(200).json({
        recording: {
          id: recording.id,
          peerId: recording.peerId,
          role: recording.role,
          fileName: recording.fileName,
          mimeType: recording.mimeType,
          size: recording.size,
          durationSeconds: recording.durationSeconds,
          uploadedAt: recording.uploadedAt,
        },
      });
    } catch (error) {
      console.error("recording upload finalize failed", error);

      if (error instanceof Error) {
        if (error.message === "ROOM_SESSION_NOT_FOUND") {
          return res.status(404).json({ error: "Room session not found" });
        }

        if (error.message === "UPLOAD_ACCESS_DENIED") {
          return res.status(403).json({ error: "Upload access denied" });
        }

        if (
          error.message === "UPLOAD_SESSION_NOT_FOUND" ||
          error.message === "UPLOAD_SESSION_MISMATCH"
        ) {
          return res.status(404).json({ error: "Upload session not found" });
        }

        if (error.message === "INVALID_TOTAL_CHUNKS") {
          return res.status(400).json({ error: "Invalid total chunk count" });
        }

        if (error.message === "MISSING_CHUNKS") {
          const missingChunks = (
            error as Error & { missingChunks?: number[] }
          ).missingChunks;

          return res.status(409).json({
            error: "Missing recording chunks",
            missingChunks: missingChunks ?? [],
          });
        }
      }

      return res.status(500).json({ error: "Unable to finalize recording upload" });
    }
  }
);

app.get("/api/rooms/:roomId/recordings", (req, res) => {
  const { roomId } = req.params;

  try {
    const recordings = listRoomRecordings(roomId, req.header("x-host-token")).map(
      (recording) => ({
        id: recording.id,
        peerId: recording.peerId,
        role: recording.role,
        fileName: recording.fileName,
        mimeType: recording.mimeType,
        size: recording.size,
        durationSeconds: recording.durationSeconds,
        uploadedAt: recording.uploadedAt,
      })
    );

    return res.status(200).json({ recordings });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "ROOM_SESSION_NOT_FOUND") {
        return res.status(404).json({ error: "Room session not found" });
      }

      if (error.message === "HOST_ACCESS_DENIED") {
        return res.status(403).json({ error: "Host access denied" });
      }
    }

    return res.status(500).json({ error: "Unable to list recordings" });
  }
});

app.get("/api/rooms/:roomId/recordings/:recordingId/download", async (req, res) => {
  const { roomId, recordingId } = req.params;

  try {
    const recording = getRecordingForDownload(
      roomId,
      recordingId,
      req.header("x-host-token")
    );

    res.setHeader("Content-Type", recording.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${recording.fileName}"`
    );

    const stream = await openRecordingDownloadStream(recording);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(404).json({ error: "Recording file not found" });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "ROOM_SESSION_NOT_FOUND") {
        return res.status(404).json({ error: "Room session not found" });
      }

      if (error.message === "HOST_ACCESS_DENIED") {
        return res.status(403).json({ error: "Host access denied" });
      }

      if (error.message === "RECORDING_NOT_FOUND") {
        return res.status(404).json({ error: "Recording not found" });
      }
    }

    return res.status(500).json({ error: "Unable to download recording" });
  }
});

const httpServer = https.createServer(options, app);

const wss = new WebSocketServer({ server: httpServer });

webRtcServer = await initWebRtcServer();

wss.on("connection", async (socket) => {
  console.log("Client connected");

  socket.on("message", async (message) => {
    const parsed: ClientToServerMessage = JSON.parse(message.toString());


    switch (parsed.type) {
      case "join-room": {
        joinRoom(parsed.payload, socket);
        break;
      }

      case "close-room": {
        close(socket);

        break;
      }
      case "getRtpCapabilities": {
        getRtpCapabilities(socket);

        break;
      }
      case "createTransport": {
        createProducerTransport(webRtcServer, socket);
        break;
      }
      case "transport-connect": {
        producerTransportConnect(parsed.payload, socket);
        break;
      }

      case "transport-produce": {
        transportProduce(parsed.payload, socket);
        break;
      }
      case "create-consumerTransport": {
        createConsumerTransport(webRtcServer, socket);
        break;
      }
      case "consumer-connect": {

        consumerConnect(parsed.payload, socket);
        break;
      }
      case "consumer-ready-for-consume":{
        consumerReadyForConsume(socket)
break;
      }
      case "consumer-ready": {
        consumerReady(parsed.payload, socket);
        break;
      }
    }
  });

  socket.on("close", () => {
    const { roomId } = safeContext(socket);
    if (!roomId) return;
    console.log("Client disconnected");
    cleanupPeer(socket, roomId);
  });
});

httpServer.listen(serverConfig.port, serverConfig.host, () => {
  console.log(`Server running on ${serverConfig.host}:${serverConfig.port}`);
});
