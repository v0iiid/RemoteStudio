import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { serverConfig } from "./config.js";
import {
  openStoredRecordingStream,
  storeRecordingFile,
  type StoredRecordingObject,
} from "./storage.js";

export interface SessionPeer {
  peerId: string;
  isHost: boolean;
  uploadToken: string;
  joinedAt: string;
}

export interface RecordingAsset extends StoredRecordingObject {
  id: string;
  roomId: string;
  peerId: string;
  role: "host" | "guest";
  fileName: string;
  mimeType: string;
  size: number;
  durationSeconds: number;
  uploadedAt: string;
}

export interface RecordingUploadSession {
  id: string;
  roomId: string;
  peerId: string;
  role: "host" | "guest";
  mimeType: string;
  extension: string;
  tempDir: string;
  createdAt: string;
  uploadedChunkCount: number;
  uploadedBytes: number;
}

export interface RoomSession {
  roomId: string;
  hostToken: string;
  hostPeerId: string | null;
  createdAt: string;
  peers: Map<string, SessionPeer>;
  recordings: Map<string, RecordingAsset>;
}

const defaultMimeType = "video/webm";
const chunkPaddingLength = 8;

export const roomSessions = new Map<string, RoomSession>();
const recordingUploadSessions = new Map<string, RecordingUploadSession>();

const mimeTypeToExtension = (mimeType: string) => {
  if (mimeType.includes("mp4")) {
    return "mp4";
  }

  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  return "webm";
};

const getChunkFileName = (chunkIndex: number) =>
  `chunk-${chunkIndex.toString().padStart(chunkPaddingLength, "0")}.part`;

const ensureRoomSession = (roomId: string) => {
  const existingSession = roomSessions.get(roomId);

  if (existingSession) {
    return existingSession;
  }

  const session: RoomSession = {
    roomId,
    hostToken: crypto.randomUUID(),
    hostPeerId: null,
    createdAt: new Date().toISOString(),
    peers: new Map(),
    recordings: new Map(),
  };

  roomSessions.set(roomId, session);
  return session;
};

const ensureHostAccess = (roomId: string, hostToken: string | undefined) => {
  const session = roomSessions.get(roomId);

  if (!session) {
    throw new Error("ROOM_SESSION_NOT_FOUND");
  }

  if (!hostToken || hostToken !== session.hostToken) {
    throw new Error("HOST_ACCESS_DENIED");
  }

  return session;
};

const getAuthorizedPeer = (
  roomId: string,
  peerId: string,
  uploadToken: string | undefined
) => {
  const session = roomSessions.get(roomId);

  if (!session) {
    throw new Error("ROOM_SESSION_NOT_FOUND");
  }

  const sessionPeer = session.peers.get(peerId);

  if (!sessionPeer || !uploadToken || sessionPeer.uploadToken !== uploadToken) {
    throw new Error("UPLOAD_ACCESS_DENIED");
  }

  return {
    session,
    sessionPeer,
  };
};

const getUploadSessionTempDir = (roomId: string, uploadSessionId: string) =>
  path.join(serverConfig.uploadTempDir, roomId, uploadSessionId);

const deleteExistingRecording = async (recording: RecordingAsset | undefined) => {
  if (!recording?.filePath) {
    return;
  }

  await fs.promises.rm(recording.filePath, { force: true });
};

const cleanupUploadSession = async (uploadSessionId: string) => {
  const uploadSession = recordingUploadSessions.get(uploadSessionId);

  if (!uploadSession) {
    return;
  }

  await fs.promises.rm(uploadSession.tempDir, { recursive: true, force: true });
  recordingUploadSessions.delete(uploadSessionId);
};

const getUploadSession = ({
  roomId,
  peerId,
  uploadSessionId,
  uploadToken,
}: {
  roomId: string;
  peerId: string;
  uploadSessionId: string;
  uploadToken: string | undefined;
}) => {
  const { sessionPeer } = getAuthorizedPeer(roomId, peerId, uploadToken);
  const uploadSession = recordingUploadSessions.get(uploadSessionId);

  if (!uploadSession) {
    throw new Error("UPLOAD_SESSION_NOT_FOUND");
  }

  if (uploadSession.roomId !== roomId || uploadSession.peerId !== peerId) {
    throw new Error("UPLOAD_SESSION_MISMATCH");
  }

  if (uploadSession.role !== (sessionPeer.isHost ? "host" : "guest")) {
    throw new Error("UPLOAD_SESSION_MISMATCH");
  }

  return uploadSession;
};

const createAssembledFile = async ({
  uploadSession,
  totalChunks,
}: {
  uploadSession: RecordingUploadSession;
  totalChunks: number;
}) => {
  const assembledFilePath = path.join(
    uploadSession.tempDir,
    `assembled.${uploadSession.extension}`
  );

  await fs.promises.rm(assembledFilePath, { force: true });

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const chunkPath = path.join(
      uploadSession.tempDir,
      getChunkFileName(chunkIndex)
    );

    await fs.promises.access(chunkPath, fs.constants.F_OK);
    const chunkBuffer = await fs.promises.readFile(chunkPath);
    await fs.promises.appendFile(assembledFilePath, chunkBuffer);
  }

  return assembledFilePath;
};

export const createRoomSession = (roomId: string) => ensureRoomSession(roomId);

export const registerSessionPeer = (
  roomId: string,
  peerId: string,
  providedHostToken?: string
) => {
  const session = ensureRoomSession(roomId);
  const isFirstPeer = session.peers.size === 0 && session.hostPeerId === null;
  const isHost =
    providedHostToken === session.hostToken || (isFirstPeer && !providedHostToken);

  const sessionPeer: SessionPeer = {
    peerId,
    isHost,
    uploadToken: crypto.randomUUID(),
    joinedAt: new Date().toISOString(),
  };

  session.peers.set(peerId, sessionPeer);

  if (isHost) {
    session.hostPeerId = peerId;
  }

  return sessionPeer;
};

export const removeSessionPeer = (roomId: string, peerId: string) => {
  const session = roomSessions.get(roomId);

  if (!session) {
    return;
  }

  session.peers.delete(peerId);

  if (session.hostPeerId === peerId) {
    session.hostPeerId = null;
  }
};

export const startRecordingUploadSession = async ({
  roomId,
  peerId,
  uploadToken,
  mimeType,
}: {
  roomId: string;
  peerId: string;
  uploadToken: string | undefined;
  mimeType?: string;
}) => {
  const { session, sessionPeer } = getAuthorizedPeer(roomId, peerId, uploadToken);
  const previousUploadSessions = [...recordingUploadSessions.values()].filter(
    (recordingUploadSession) =>
      recordingUploadSession.roomId === roomId &&
      recordingUploadSession.peerId === peerId
  );

  await Promise.all(
    previousUploadSessions.map((recordingUploadSession) =>
      cleanupUploadSession(recordingUploadSession.id)
    )
  );

  const nextMimeType = mimeType || defaultMimeType;
  const uploadSessionId = crypto.randomUUID();
  const uploadSession: RecordingUploadSession = {
    id: uploadSessionId,
    roomId,
    peerId,
    role: sessionPeer.isHost ? "host" : "guest",
    mimeType: nextMimeType,
    extension: mimeTypeToExtension(nextMimeType),
    tempDir: getUploadSessionTempDir(roomId, uploadSessionId),
    createdAt: new Date().toISOString(),
    uploadedChunkCount: 0,
    uploadedBytes: 0,
  };

  await fs.promises.mkdir(uploadSession.tempDir, { recursive: true });
  recordingUploadSessions.set(uploadSessionId, uploadSession);

  return {
    uploadSessionId,
    isHost: sessionPeer.isHost,
    hostToken: session.hostToken,
  };
};

export const storeRecordingChunk = async ({
  roomId,
  peerId,
  uploadSessionId,
  uploadToken,
  chunkIndex,
  request,
}: {
  roomId: string;
  peerId: string;
  uploadSessionId: string;
  uploadToken: string | undefined;
  chunkIndex: number;
  request: NodeJS.ReadableStream;
}) => {
  if (chunkIndex < 0 || !Number.isInteger(chunkIndex)) {
    throw new Error("INVALID_CHUNK_INDEX");
  }

  const uploadSession = getUploadSession({
    roomId,
    peerId,
    uploadSessionId,
    uploadToken,
  });
  const chunkPath = path.join(
    uploadSession.tempDir,
    getChunkFileName(chunkIndex)
  );
  const writable = fs.createWriteStream(chunkPath);
  let chunkSize = 0;

  request.on("data", (chunk: Buffer) => {
    chunkSize += chunk.length;
  });

  try {
    await pipeline(request, writable);
  } catch (error) {
    await fs.promises.rm(chunkPath, { force: true });
    throw error;
  }

  uploadSession.uploadedChunkCount += 1;
  uploadSession.uploadedBytes += chunkSize;

  return {
    chunkIndex,
    chunkSize,
  };
};

export const finalizeRecordingUpload = async ({
  roomId,
  peerId,
  uploadSessionId,
  uploadToken,
  totalChunks,
  durationSeconds,
}: {
  roomId: string;
  peerId: string;
  uploadSessionId: string;
  uploadToken: string | undefined;
  totalChunks: number;
  durationSeconds: number;
}) => {
  if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
    throw new Error("INVALID_TOTAL_CHUNKS");
  }

  const { session, sessionPeer } = getAuthorizedPeer(roomId, peerId, uploadToken);
  const uploadSession = getUploadSession({
    roomId,
    peerId,
    uploadSessionId,
    uploadToken,
  });
  const missingChunks: number[] = [];

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const chunkPath = path.join(
      uploadSession.tempDir,
      getChunkFileName(chunkIndex)
    );

    try {
      await fs.promises.access(chunkPath, fs.constants.F_OK);
    } catch {
      missingChunks.push(chunkIndex);
    }
  }

  if (missingChunks.length > 0) {
    const error = new Error("MISSING_CHUNKS");
    (error as Error & { missingChunks: number[] }).missingChunks = missingChunks;
    throw error;
  }

  await deleteExistingRecording(session.recordings.get(peerId));

  const assembledFilePath = await createAssembledFile({
    uploadSession,
    totalChunks,
  });
  const assembledFileStats = await fs.promises.stat(assembledFilePath);
  const timestamp = Date.now();
  const fileName = `${uploadSession.role}-${peerId}-${timestamp}.${uploadSession.extension}`;
  const storedObject = await storeRecordingFile({
    roomId,
    fileName,
    filePath: assembledFilePath,
    mimeType: uploadSession.mimeType,
  });
  const recording: RecordingAsset = {
    ...storedObject,
    id: peerId,
    roomId,
    peerId,
    role: sessionPeer.isHost ? "host" : "guest",
    fileName,
    mimeType: uploadSession.mimeType,
    size: assembledFileStats.size,
    durationSeconds,
    uploadedAt: new Date().toISOString(),
  };

  session.recordings.set(peerId, recording);
  await cleanupUploadSession(uploadSessionId);

  return recording;
};

export const storeUploadedRecording = async ({
  roomId,
  peerId,
  uploadToken,
  mimeType,
  durationSeconds,
  request,
}: {
  roomId: string;
  peerId: string;
  uploadToken: string | undefined;
  mimeType?: string;
  durationSeconds: number;
  request: NodeJS.ReadableStream;
}) => {
  const { sessionPeer } = getAuthorizedPeer(roomId, peerId, uploadToken);
  const nextMimeType = mimeType || defaultMimeType;
  const uploadSession = await startRecordingUploadSession({
    roomId,
    peerId,
    uploadToken,
    mimeType: nextMimeType,
  });
  const chunkPath = path.join(
    getUploadSessionTempDir(roomId, uploadSession.uploadSessionId),
    getChunkFileName(0)
  );
  const writable = fs.createWriteStream(chunkPath);

  try {
    await pipeline(request, writable);
  } catch (error) {
    await cleanupUploadSession(uploadSession.uploadSessionId);
    throw error;
  }

  const recording = await finalizeRecordingUpload({
    roomId,
    peerId,
    uploadSessionId: uploadSession.uploadSessionId,
    uploadToken,
    totalChunks: 1,
    durationSeconds,
  });

  return {
    ...recording,
    role: sessionPeer.isHost ? "host" : "guest",
  };
};

export const listRoomRecordings = (
  roomId: string,
  hostToken: string | undefined
) => {
  const session = ensureHostAccess(roomId, hostToken);

  return [...session.recordings.values()].sort((left, right) => {
    if (left.role !== right.role) {
      return left.role === "host" ? -1 : 1;
    }

    return left.uploadedAt.localeCompare(right.uploadedAt);
  });
};

export const getRecordingForDownload = (
  roomId: string,
  recordingId: string,
  hostToken: string | undefined
) => {
  const session = ensureHostAccess(roomId, hostToken);
  const recording = session.recordings.get(recordingId);

  if (!recording) {
    throw new Error("RECORDING_NOT_FOUND");
  }

  return recording;
};

export const openRecordingDownloadStream = (recording: RecordingAsset) =>
  openStoredRecordingStream(recording);

export const createRoomHostAccess = (roomId: string) => {
  const session = ensureRoomSession(roomId);

  return {
    roomId: session.roomId,
    hostToken: session.hostToken,
  };
};
