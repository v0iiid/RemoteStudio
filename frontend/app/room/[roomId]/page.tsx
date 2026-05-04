"use client";

import { ServerToClientMessage } from "@/app/types/ws-types";
import { clientConfig, clientConfigReady } from "@/lib/config";
import { getHostToken } from "@/lib/host-access";
import axios from "axios";
import * as mediasoupClient from "mediasoup-client";
import {
  Consumer,
  Producer,
  Transport,
  TransportOptions,
} from "mediasoup-client/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

type RemoteConsumerPayload = Extract<
  ServerToClientMessage,
  { type: "newConsumer" }
>["payload"];
type UploadedRecording = {
  id: string;
  peerId: string;
  role: "host" | "guest";
  fileName: string;
  mimeType: string;
  size: number;
  durationSeconds: number;
  uploadedAt: string;
};
type UploadQueueItem = {
  blob: Blob;
  chunkIndex: number;
};

const addUniqueId = (items: string[], nextId: string) =>
  items.includes(nextId) ? items : [...items, nextId];
const sleep = (delayMs: number) =>
  new Promise((resolve) => window.setTimeout(resolve, delayMs));

const recordingMimeTypes = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const formatDuration = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.max(totalSeconds % 60, 0)
    .toString()
    .padStart(2, "0");

  return `${minutes}:${seconds}`;
};

const formatFileSize = (totalBytes: number) => {
  if (totalBytes < 1024 * 1024) {
    return `${Math.max(totalBytes / 1024, 0.1).toFixed(1)} KB`;
  }

  return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getRecordingLabel = (
  recording: UploadedRecording,
  guestIndexByPeerId: Map<string, number>
) => {
  if (recording.role === "host") {
    return "Host master";
  }

  const guestIndex = guestIndexByPeerId.get(recording.peerId) ?? 1;
  return `Guest ${guestIndex} master`;
};

const getRecorderOptions = (): MediaRecorderOptions => {
  if (typeof MediaRecorder === "undefined") {
    return {};
  }

  const mimeType = recordingMimeTypes.find((candidate) =>
    MediaRecorder.isTypeSupported(candidate)
  );

  return mimeType
    ? {
        mimeType,
        audioBitsPerSecond: 192000,
        videoBitsPerSecond: 12_000_000,
      }
    : {
        audioBitsPerSecond: 192000,
        videoBitsPerSecond: 12_000_000,
      };
};

export default function Room() {
  const socketRef = useRef<WebSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const producerTransportRef = useRef<Transport | null>(null);
  const consumerTransportRef = useRef<Transport | null>(null);
  const hasProducedRef = useRef(false);
  const producerRef = useRef<Map<string, Producer>>(new Map());
  const consumerRef = useRef<Map<string, Consumer>>(new Map());
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const pendingConsumers = useRef<RemoteConsumerPayload[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  const produceCallbackRef = useRef<((data: { id: string }) => void) | null>(
    null
  );
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingBlobRef = useRef<Blob | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const recordingUrlRef = useRef<string | null>(null);
  const uploadSessionIdRef = useRef("");
  const uploadQueueRef = useRef<UploadQueueItem[]>([]);
  const isUploadingChunksRef = useRef(false);
  const shouldFinalizeUploadRef = useRef(false);
  const totalRecordedChunksRef = useRef(0);
  const pendingLeaveRef = useRef(false);

  const { roomId } = useParams<{ roomId: string }>();
  const router = useRouter();

  const [peerId, setPeerId] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [hostToken, setHostToken] = useState("");
  const [hostAccessReady, setHostAccessReady] = useState(false);
  const [uploadToken, setUploadToken] = useState("");
  const [remoteVideoIds, setRemoteVideoIds] = useState<string[]>([]);
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [roomChecked, setRoomChecked] = useState(false);
  const [deviceLoaded, setDeviceLoaded] = useState(false);
  const [sendTransportReady, setSendTransportReady] = useState(false);
  const [receiveTransportReady, setReceiveTransportReady] = useState(false);
  const [remoteAudioCount, setRemoteAudioCount] = useState(0);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isMicEnabled, setIsMicEnabled] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [cameraState, setCameraState] = useState<
    "idle" | "starting" | "live" | "error"
  >("idle");
  const [cameraError, setCameraError] = useState("");
  const [recordingState, setRecordingState] = useState<
    "idle" | "recording" | "processing" | "ready" | "error"
  >("idle");
  const [uploadState, setUploadState] = useState<
    "idle" | "uploading" | "uploaded" | "error"
  >("idle");
  const [recordingError, setRecordingError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [recordingDurationSeconds, setRecordingDurationSeconds] = useState(0);
  const [recordingSize, setRecordingSize] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState("");
  const [uploadedChunkCount, setUploadedChunkCount] = useState(0);
  const [totalChunkCount, setTotalChunkCount] = useState(0);
  const [hostRecordings, setHostRecordings] = useState<UploadedRecording[]>([]);
  const [isLoadingRecordings, setIsLoadingRecordings] = useState(false);
  const [downloadingRecordingId, setDownloadingRecordingId] = useState("");
  const [statusLabel, setStatusLabel] = useState("Checking room...");
  const [copied, setCopied] = useState(false);
  const recordingSupported =
    typeof window !== "undefined" && typeof MediaRecorder !== "undefined";

  useEffect(() => {
    if (!roomId) {
      return;
    }

    setHostToken(getHostToken(roomId));
    setHostAccessReady(true);
  }, [roomId]);

  const removeRemoteProducer = useCallback((producerId: string) => {
    const consumer = consumerRef.current.get(producerId);
    if (consumer) {
      consumer.close();
      consumerRef.current.delete(producerId);
    }

    const audioElement = audioRefs.current.get(producerId);
    if (audioElement) {
      audioElement.pause();
      audioElement.srcObject = null;
      audioRefs.current.delete(producerId);
      setRemoteAudioCount(audioRefs.current.size);
    }

    const videoElement = remoteVideoRef.current.get(producerId);
    if (videoElement) {
      videoElement.srcObject = null;
    }

    setRemoteVideoIds((current) => current.filter((id) => id !== producerId));
  }, []);

  const attachConsumerToVideo = useCallback((producerId: string) => {
    const consumer = consumerRef.current.get(producerId);

    if (!consumer) {
      return;
    }

    if (consumer.kind === "audio") {
      if (!audioRefs.current.has(producerId)) {
        const audioElement = new Audio();
        audioElement.srcObject = new MediaStream([consumer.track]);
        audioElement.autoplay = true;
        audioElement.play().catch(() => {});
        audioRefs.current.set(producerId, audioElement);
        setRemoteAudioCount(audioRefs.current.size);
      }

      return;
    }

    const videoElement = remoteVideoRef.current.get(producerId);

    if (!videoElement || videoElement.srcObject) {
      return;
    }

    videoElement.srcObject = new MediaStream([consumer.track]);
    videoElement.play().catch(() => {});
  }, []);

  const handleNewConsumer = useCallback(
    async (payload: RemoteConsumerPayload, transport: Transport) => {
      if (consumerRef.current.has(payload.producerId)) {
        return;
      }

      const consumer = await transport.consume({
        id: payload.id,
        producerId: payload.producerId,
        kind: payload.kind,
        rtpParameters: payload.rtpParameters,
      });

      consumerRef.current.set(payload.producerId, consumer);
      consumer.track.onended = () => removeRemoteProducer(payload.producerId);

      if (payload.kind === "video") {
        setRemoteVideoIds((current) => addUniqueId(current, payload.producerId));
      }

      attachConsumerToVideo(payload.producerId);

      await consumer.resume();
      socketRef.current?.send(
        JSON.stringify({
          type: "consumer-ready",
          payload: { consumerId: consumer.id },
        })
      );
    },
    [attachConsumerToVideo, removeRemoteProducer]
  );

  const attachVideoRef = useCallback(
    (producerId: string, element: HTMLVideoElement | null) => {
      if (element) {
        remoteVideoRef.current.set(producerId, element);
        attachConsumerToVideo(producerId);
        return;
      }

      remoteVideoRef.current.delete(producerId);
    },
    [attachConsumerToVideo]
  );

  const clearRecordingAsset = useCallback(() => {
    if (recordingUrlRef.current) {
      URL.revokeObjectURL(recordingUrlRef.current);
      recordingUrlRef.current = null;
    }

    uploadSessionIdRef.current = "";
    uploadQueueRef.current = [];
    isUploadingChunksRef.current = false;
    shouldFinalizeUploadRef.current = false;
    totalRecordedChunksRef.current = 0;
    recordingBlobRef.current = null;
    setRecordingUrl("");
    setRecordingSize(0);
    setUploadedChunkCount(0);
    setTotalChunkCount(0);
  }, []);

  const fetchHostRecordings = useCallback(async () => {
    if (!clientConfigReady || !roomId || !hostToken || !isHost) {
      return;
    }

    try {
      setIsLoadingRecordings(true);
      const response = await axios.get(
        `${clientConfig.apiBaseUrl}/api/rooms/${roomId}/recordings`,
        {
          headers: {
            "x-host-token": hostToken,
          },
        }
      );

      setHostRecordings(response.data.recordings ?? []);
    } catch (error) {
      console.error("failed to fetch room recordings", error);
    } finally {
      setIsLoadingRecordings(false);
    }
  }, [hostToken, isHost, roomId]);

  const createRecordingUploadSession = useCallback(
    async (mimeType: string) => {
      if (!clientConfigReady) {
        setUploadState("error");
        setUploadError(
          "Frontend env is missing. Set NEXT_PUBLIC_API_BASE_URL and NEXT_PUBLIC_WS_URL."
        );
        return "";
      }

      if (!peerId || !uploadToken) {
        setUploadState("error");
        setUploadError("The upload session is not ready yet. Stay in the room and retry.");
        return "";
      }

      try {
        const response = await axios.post(
          `${clientConfig.apiBaseUrl}/api/rooms/${roomId}/recordings/${peerId}/upload-session`,
          { mimeType },
          {
            headers: {
              "x-recording-token": uploadToken,
            },
          }
        );
        const nextUploadSessionId = response.data.uploadSessionId as string;

        uploadSessionIdRef.current = nextUploadSessionId;
        return nextUploadSessionId;
      } catch (error) {
        console.error("recording upload session start failed", error);
        setUploadState("error");
        setUploadError(
          "Live upload could not start. Your local backup is still safe, and you can retry after stopping."
        );
        return "";
      }
    },
    [peerId, roomId, uploadToken]
  );

  const uploadChunkWithRetry = useCallback(
    async (uploadSessionId: string, item: UploadQueueItem) => {
      let attempt = 0;

      while (attempt < clientConfig.recordingChunkRetryCount) {
        try {
          await axios.put(
            `${clientConfig.apiBaseUrl}/api/rooms/${roomId}/recordings/${peerId}/upload-session/${uploadSessionId}/chunks/${item.chunkIndex}`,
            item.blob,
            {
              headers: {
                "Content-Type": item.blob.type || "application/octet-stream",
                "x-recording-token": uploadToken,
              },
              maxBodyLength: Infinity,
              maxContentLength: Infinity,
            }
          );
          return;
        } catch (error) {
          attempt += 1;

          if (attempt >= clientConfig.recordingChunkRetryCount) {
            throw error;
          }

          await sleep(
            clientConfig.recordingChunkRetryBaseMs * 2 ** (attempt - 1)
          );
        }
      }
    },
    [peerId, roomId, uploadToken]
  );

  const finalizeChunkUpload = useCallback(
    async (durationSeconds: number) => {
      const uploadSessionId = uploadSessionIdRef.current;

      if (!uploadSessionId) {
        return true;
      }

      try {
        setStatusLabel("Finalizing upload...");

        await axios.post(
          `${clientConfig.apiBaseUrl}/api/rooms/${roomId}/recordings/${peerId}/upload-session/${uploadSessionId}/finalize`,
          {
            totalChunks: totalRecordedChunksRef.current,
            durationSeconds,
          },
          {
            headers: {
              "x-recording-token": uploadToken,
            },
          }
        );

        uploadSessionIdRef.current = "";
        shouldFinalizeUploadRef.current = false;
        setUploadState("uploaded");
        setStatusLabel(
          isHost
            ? "Local master uploaded. Waiting for guest uploads."
            : "Local master uploaded."
        );

        if (isHost) {
          void fetchHostRecordings();
        }

        if (pendingLeaveRef.current) {
          pendingLeaveRef.current = false;
          router.push("/");
        }

        return true;
      } catch (error) {
        console.error("recording upload finalize failed", error);

        if (axios.isAxiosError(error) && error.response?.status === 409) {
          const missingChunks = Array.isArray(error.response.data?.missingChunks)
            ? (error.response.data.missingChunks as number[])
            : [];
          const queuedChunkIndexes = new Set(
            uploadQueueRef.current.map((item) => item.chunkIndex)
          );

          for (const chunkIndex of missingChunks) {
            const missingChunk = recordingChunksRef.current[chunkIndex];

            if (!missingChunk || queuedChunkIndexes.has(chunkIndex)) {
              continue;
            }

            uploadQueueRef.current.push({
              blob: missingChunk,
              chunkIndex,
            });
          }

          setStatusLabel("Retrying missing chunks...");
          return false;
        }

        uploadSessionIdRef.current = "";
        shouldFinalizeUploadRef.current = false;
        setUploadState("error");
        setUploadError(
          "Chunk finalize failed. Keep the local copy and retry the upload."
        );

        if (pendingLeaveRef.current) {
          pendingLeaveRef.current = false;
          setStatusLabel("Upload failed. Save the local master before leaving.");
        }

        return true;
      }
    },
    [fetchHostRecordings, isHost, peerId, roomId, router, uploadToken]
  );

  const pumpUploadQueue = useCallback(
    async (durationSeconds: number) => {
      const uploadSessionId = uploadSessionIdRef.current;

      if (!uploadSessionId || isUploadingChunksRef.current) {
        return;
      }

      isUploadingChunksRef.current = true;
      setUploadState("uploading");
      setUploadError("");

      try {
        while (true) {
          while (uploadQueueRef.current.length > 0) {
            const nextItem = uploadQueueRef.current[0];

            await uploadChunkWithRetry(uploadSessionId, nextItem);
            uploadQueueRef.current.shift();
            setUploadedChunkCount((current) =>
              Math.max(current, nextItem.chunkIndex + 1)
            );
          }

          if (!shouldFinalizeUploadRef.current) {
            break;
          }

          const finalizeCompleted = await finalizeChunkUpload(durationSeconds);

          if (finalizeCompleted) {
            break;
          }
        }
      } catch (error) {
        console.error("recording chunk upload failed", error);
        setUploadState("error");
        setUploadError(
          "Chunk upload paused. Keep this tab open and retry when the network is stable."
        );

        if (pendingLeaveRef.current) {
          pendingLeaveRef.current = false;
          setStatusLabel("Upload paused. Save the local master before leaving.");
        }
      } finally {
        isUploadingChunksRef.current = false;
      }
    },
    [finalizeChunkUpload, uploadChunkWithRetry]
  );

  const enqueueRecordingChunk = useCallback(
    (blob: Blob, durationSeconds: number) => {
      recordingChunksRef.current.push(blob);

      const chunkIndex = totalRecordedChunksRef.current;
      totalRecordedChunksRef.current += 1;
      setTotalChunkCount(totalRecordedChunksRef.current);

      if (!uploadSessionIdRef.current) {
        return;
      }

      uploadQueueRef.current.push({ blob, chunkIndex });
      void pumpUploadQueue(durationSeconds);
    },
    [pumpUploadQueue]
  );

  const retryRecordingUpload = useCallback(async () => {
    if (recordingChunksRef.current.length === 0) {
      return;
    }

    const mimeType = recordingBlobRef.current?.type || "video/webm";
    const nextUploadSessionId = await createRecordingUploadSession(mimeType);

    if (!nextUploadSessionId) {
      return;
    }

    uploadQueueRef.current = recordingChunksRef.current.map((blob, chunkIndex) => ({
      blob,
      chunkIndex,
    }));
    shouldFinalizeUploadRef.current = true;
    totalRecordedChunksRef.current = recordingChunksRef.current.length;
    setTotalChunkCount(recordingChunksRef.current.length);
    setUploadedChunkCount(0);
    setUploadState("uploading");
    setUploadError("");
    setStatusLabel("Retrying chunk upload...");
    await pumpUploadQueue(recordingDurationSeconds);
  }, [createRecordingUploadSession, pumpUploadQueue, recordingDurationSeconds]);

  const stopLocalRecording = useCallback(() => {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state !== "recording") {
      return;
    }

    setRecordingState("processing");
    setStatusLabel("Finalizing local master...");
    recorder.stop();
  }, []);

  const startLocalRecording = useCallback(async () => {
    const stream = localStreamRef.current;

    if (!recordingSupported) {
      setRecordingState("error");
      setRecordingError("This browser does not support local recording.");
      return;
    }

    if (!stream || cameraState !== "live") {
      setRecordingError("Start your camera before recording.");
      return;
    }

    try {
      const recorderOptions = getRecorderOptions();
      const nextMimeType = recorderOptions.mimeType || "video/webm";

      clearRecordingAsset();
      recordingChunksRef.current = [];
      pendingLeaveRef.current = false;
      setRecordingError("");
      setUploadError("");
      setUploadState("idle");
      setRecordingDurationSeconds(0);
      setUploadedChunkCount(0);
      setTotalChunkCount(0);

      await createRecordingUploadSession(nextMimeType);

      const recorder = new MediaRecorder(stream, recorderOptions);

      recorderRef.current = recorder;
      recordingStartTimeRef.current = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          const startedAt = recordingStartTimeRef.current;
          const durationSeconds = startedAt
            ? Math.max(1, Math.round((Date.now() - startedAt) / 1000))
            : recordingDurationSeconds;

          enqueueRecordingChunk(event.data, durationSeconds);
        }
      };

      recorder.onerror = () => {
        setRecordingState("error");
        setRecordingError("Local recording stopped unexpectedly.");
        recordingStartTimeRef.current = null;
      };

      recorder.onstop = () => {
        const startedAt = recordingStartTimeRef.current;
        const stoppedAt = Date.now();
        const nextDuration = startedAt
          ? Math.max(1, Math.round((stoppedAt - startedAt) / 1000))
          : recordingDurationSeconds;
        const blob = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || "video/webm",
        });
        const nextUrl = URL.createObjectURL(blob);

        if (recordingUrlRef.current) {
          URL.revokeObjectURL(recordingUrlRef.current);
        }

        recordingBlobRef.current = blob;
        recordingUrlRef.current = nextUrl;
        recordingStartTimeRef.current = null;
        setRecordingDurationSeconds(nextDuration);
        setRecordingSize(blob.size);
        setRecordingUrl(nextUrl);
        setRecordingState("ready");
        setStatusLabel("Local master ready.");
        shouldFinalizeUploadRef.current = true;
        void pumpUploadQueue(nextDuration);
      };

      recorder.start(clientConfig.recordingChunkTimesliceMs);
      setRecordingState("recording");
      setStatusLabel(
        uploadSessionIdRef.current
          ? "Recording locally in HD. Uploading chunks..."
          : "Recording locally in HD. Upload will retry later."
      );
    } catch (err) {
      console.error("local recording failed", err);
      setRecordingState("error");
      setRecordingError("Unable to start the local recorder on this device.");
    }
  }, [
    cameraState,
    clearRecordingAsset,
    createRecordingUploadSession,
    enqueueRecordingChunk,
    pumpUploadQueue,
    recordingDurationSeconds,
    recordingSupported,
  ]);

  const toggleLocalMedia = useCallback(
    (kind: "audio" | "video") => {
      const stream = localStreamRef.current;

      if (!stream || cameraState !== "live") {
        return;
      }

      const nextEnabled = kind === "audio" ? !isMicEnabled : !isVideoEnabled;
      const tracks =
        kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();

      tracks.forEach((track) => {
        track.enabled = nextEnabled;
      });

      producerRef.current.forEach((producer) => {
        if (producer.track?.kind !== kind) {
          return;
        }

        if (nextEnabled) {
          producer.resume();
          return;
        }

        producer.pause();
      });

      if (kind === "audio") {
        setIsMicEnabled(nextEnabled);
        setStatusLabel(nextEnabled ? "Microphone on" : "Microphone muted");
        return;
      }

      setIsVideoEnabled(nextEnabled);
      setStatusLabel(nextEnabled ? "Camera on" : "Camera off");
    },
    [cameraState, isMicEnabled, isVideoEnabled]
  );

  const downloadLocalRecording = useCallback(() => {
    if (!recordingUrl) {
      return;
    }

    const link = document.createElement("a");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    link.href = recordingUrl;
    link.download = `remotestudio-${roomId}-${timestamp}.webm`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [recordingUrl, roomId]);

  const downloadHostRecording = useCallback(
    async (recording: UploadedRecording) => {
      if (!clientConfigReady || !hostToken) {
        return;
      }

      try {
        setDownloadingRecordingId(recording.id);
        const response = await axios.get(
          `${clientConfig.apiBaseUrl}/api/rooms/${roomId}/recordings/${recording.id}/download`,
          {
            headers: {
              "x-host-token": hostToken,
            },
            responseType: "blob",
          }
        );

        const nextUrl = URL.createObjectURL(response.data as Blob);
        const link = document.createElement("a");

        link.href = nextUrl;
        link.download = recording.fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(nextUrl);
      } catch (error) {
        console.error("failed to download room recording", error);
      } finally {
        setDownloadingRecordingId("");
      }
    },
    [hostToken, roomId]
  );

  const leaveRoom = useCallback(() => {
    if (recordingState === "recording") {
      pendingLeaveRef.current = true;
      stopLocalRecording();
      return;
    }

    if (recordingState === "processing" || uploadState === "uploading") {
      pendingLeaveRef.current = true;
      setStatusLabel("Wait for the local master to finish.");
      return;
    }

    if (recordingChunksRef.current.length > 0 && uploadState !== "uploaded") {
      pendingLeaveRef.current = true;
      void retryRecordingUpload();
      return;
    }

    router.push("/");
  }, [
    recordingState,
    retryRecordingUpload,
    router,
    stopLocalRecording,
    uploadState,
  ]);

  async function startCamera() {
    if (cameraState === "starting" || cameraState === "live") {
      return;
    }

    try {
      setCameraError("");
      setStatusLabel("Requesting camera and microphone...");
      setCameraState("starting");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: {
          channelCount: { ideal: 2 },
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: { ideal: 48000 },
        },
      });

      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        await localVideoRef.current.play().catch(() => {});
      }

      setIsMicEnabled(true);
      setIsVideoEnabled(true);
      setCameraState("live");
      setStatusLabel(
        sendTransportReady ? "Camera live. Publishing to the room..." : "Camera ready."
      );
    } catch (err) {
      console.error("camera start failed", err);
      setCameraState("error");
      setStatusLabel("Camera access blocked");
      setCameraError(
        "Camera or microphone access was blocked. Allow permission and try again."
      );
    }
  }

  async function copyRoomId() {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      console.error("copy failed", err);
    }
  }

  useEffect(() => {
    if (!roomId || !hostAccessReady) {
      return;
    }

    let isMounted = true;
    const localVideoElement = localVideoRef.current;
    const producerMap = producerRef.current;
    const consumerMap = consumerRef.current;
    const audioMap = audioRefs.current;
    const remoteVideoMap = remoteVideoRef.current;

    if (!clientConfigReady) {
      setCameraError(
        "Frontend env is missing. Set NEXT_PUBLIC_API_BASE_URL and NEXT_PUBLIC_WS_URL."
      );
      setStatusLabel("Configuration missing");
      return;
    }

    const connectWebSocket = () => {
      const ws = new WebSocket(clientConfig.wsUrl);

      socketRef.current = ws;
      deviceRef.current = new mediasoupClient.Device();

      ws.onopen = () => {
        setStatusLabel("Joining room...");
        ws.send(
          JSON.stringify({
            type: "join-room",
            payload: { joinRoomId: roomId, hostToken: hostToken || undefined },
          })
        );
      };

      ws.onmessage = async (message) => {
        const parsed: ServerToClientMessage = JSON.parse(message.data.toString());
        const device = deviceRef.current;

        if (!device) {
          return;
        }

        switch (parsed.type) {
          case "room-not-found":
            ws.close();
            socketRef.current = null;
            router.replace("/");
            return;

          case "joined-room":
            setPeerId(parsed.payload.peerId);
            setIsHost(parsed.payload.isHost);
            setUploadToken(parsed.payload.uploadToken);
            setParticipantIds([parsed.payload.peerId, ...parsed.payload.existingPeerIds]);
            setStatusLabel(
              parsed.payload.isHost
                ? "Studio connected. Host access ready."
                : parsed.payload.existingPeerIds.length > 0
                  ? "Guest joined"
                  : "Studio connected"
            );
            ws.send(JSON.stringify({ type: "getRtpCapabilities" }));
            break;

          case "peer-joined":
            setParticipantIds((current) => addUniqueId(current, parsed.payload.peerId));
            setStatusLabel("Guest joined");
            break;

          case "peer-left":
            setParticipantIds((current) => current.filter((id) => id !== parsed.payload.peerId));
            parsed.payload.producerIds.forEach((producerId) => removeRemoteProducer(producerId));
            setStatusLabel("Guest left");
            break;

          case "rtpCapabilities":
            try {
              await device.load({
                routerRtpCapabilities: parsed.payload.rtpCapabilities,
              });
              setDeviceLoaded(true);
              setStatusLabel("Preparing transports...");
              ws.send(JSON.stringify({ type: "createTransport" }));
              ws.send(JSON.stringify({ type: "create-consumerTransport" }));
            } catch (err) {
              console.error("device load failed", err);
              setStatusLabel("This browser is not supported");
            }
            break;

          case "transportCreated":
            try {
              const producerTransport =
                device.createSendTransport<TransportOptions>({
                  id: parsed.payload.id,
                  iceParameters: parsed.payload.iceParameters,
                  iceCandidates: parsed.payload.iceCandidates,
                  dtlsParameters: parsed.payload.dtlsParameters,
                  sctpParameters: parsed.payload.sctpParameters,
                });

              producerTransport.on("connect", ({ dtlsParameters }, callback) => {
                try {
                  ws.send(
                    JSON.stringify({
                      type: "transport-connect",
                      payload: {
                        transportId: producerTransport.id,
                        dtlsParameters,
                      },
                    })
                  );
                  callback();
                } catch (err) {
                  console.error("transport connect failed", err);
                }
              });

              producerTransport.on("produce", (parameters, callback, errback) => {
                try {
                  const currentSocket = socketRef.current;

                  if (!currentSocket) {
                    return;
                  }

                  produceCallbackRef.current = callback;

                  currentSocket.send(
                    JSON.stringify({
                      type: "transport-produce",
                      payload: {
                        transportId: producerTransport.id,
                        kind: parameters.kind,
                        rtpParameters: parameters.rtpParameters,
                        appData: parameters.appData,
                      },
                    })
                  );
                } catch (err) {
                  errback(
                    err instanceof Error
                      ? err
                      : new Error("transport produce failed")
                  );
                }
              });

              producerTransport.on("connectionstatechange", (state) => {
                console.log("producer transport state", state);
              });

              producerTransportRef.current = producerTransport;
              setSendTransportReady(true);
              setStatusLabel("Studio ready. Start your camera when you want to go live.");
            } catch (err) {
              console.error("error in createTransport", err);
            }
            break;

          case "consumerTransportCreated":
            try {
              const consumerTransport = device.createRecvTransport({
                id: parsed.payload.id,
                iceParameters: parsed.payload.iceParameters,
                iceCandidates: parsed.payload.iceCandidates,
                dtlsParameters: parsed.payload.dtlsParameters,
                sctpParameters: parsed.payload.sctpParameters,
              });

              consumerTransportRef.current = consumerTransport;
              setReceiveTransportReady(true);

              consumerTransport.on("connect", ({ dtlsParameters }, callback) => {
                try {
                  ws.send(
                    JSON.stringify({
                      type: "consumer-connect",
                      payload: {
                        transportId: consumerTransport.id,
                        dtlsParameters,
                      },
                    })
                  );
                  callback();
                } catch (err) {
                  console.error("consumer connect failed", err);
                }
              });

              consumerTransport.on("connectionstatechange", (state) => {
                if (state === "connected") {
                  setStatusLabel("Studio ready");
                }
              });

              ws.send(JSON.stringify({ type: "consumer-ready-for-consume" }));

              if (pendingConsumers.current.length > 0) {
                const queuedConsumers = [...pendingConsumers.current];
                pendingConsumers.current = [];

                for (const payload of queuedConsumers) {
                  await handleNewConsumer(payload, consumerTransport);
                }
              }
            } catch (err) {
              console.error("consumer transport failed", err);
            }
            break;

          case "produce-data":
            produceCallbackRef.current?.({ id: parsed.payload.id });
            produceCallbackRef.current = null;
            break;

          case "newConsumer": {
            const consumerTransport = consumerTransportRef.current;

            if (!consumerTransport) {
              pendingConsumers.current.push(parsed.payload);
              setStatusLabel("Guest joined");
              return;
            }

            await handleNewConsumer(parsed.payload, consumerTransport);
            setStatusLabel("Guest live");
            break;
          }
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket error", err);
      };

      ws.onclose = () => {
        router.replace("/");
      };
    };

    const checkRoom = async () => {
      try {
        await axios.get(`${clientConfig.apiBaseUrl}/api/rooms/${roomId}`);

        if (!isMounted) {
          return;
        }

        setRoomChecked(true);
        setStatusLabel("Room verified. Connecting to the studio...");

        if (!socketRef.current) {
          connectWebSocket();
        }
      } catch (err) {
        if (!isMounted) {
          return;
        }

        console.error("Room check failed", err);
        router.replace("/");
      }
    };

    checkRoom();

    return () => {
      isMounted = false;

      const ws = socketRef.current;

      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.close();
        socketRef.current = null;
      }

      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      localVideoElement?.pause();

      const recorder = recorderRef.current;

      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }

      recorderRef.current = null;
      recordingStartTimeRef.current = null;
      recordingChunksRef.current = [];
      uploadSessionIdRef.current = "";
      uploadQueueRef.current = [];
      isUploadingChunksRef.current = false;
      shouldFinalizeUploadRef.current = false;
      totalRecordedChunksRef.current = 0;

      if (recordingUrlRef.current) {
        URL.revokeObjectURL(recordingUrlRef.current);
        recordingUrlRef.current = null;
      }

      producerMap.forEach((producer) => producer.close());
      consumerMap.forEach((consumer) => consumer.close());
      audioMap.forEach((audioElement) => {
        audioElement.pause();
        audioElement.srcObject = null;
      });

      producerTransportRef.current?.close();
      consumerTransportRef.current?.close();
      remoteVideoMap.clear();
      audioMap.clear();
    };
  }, [
    clearRecordingAsset,
    handleNewConsumer,
    hostAccessReady,
    hostToken,
    removeRemoteProducer,
    roomId,
    router,
  ]);

  useEffect(() => {
    if (recordingState !== "recording") {
      return;
    }

    const interval = window.setInterval(() => {
      const startedAt = recordingStartTimeRef.current;

      if (!startedAt) {
        return;
      }

      setRecordingDurationSeconds(
        Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      );
    }, 1000);

    return () => window.clearInterval(interval);
  }, [recordingState]);

  useEffect(() => {
    if (!isHost || !hostToken) {
      setHostRecordings([]);
      return;
    }

    void fetchHostRecordings();
    const interval = window.setInterval(() => {
      void fetchHostRecordings();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [fetchHostRecordings, hostToken, isHost]);

  useEffect(() => {
    const transport = producerTransportRef.current;
    const stream = localStreamRef.current;

    if (!transport || !stream || hasProducedRef.current) {
      return;
    }

    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];

    const produce = async () => {
      try {
        setStatusLabel("Publishing your media...");

        if (videoTrack) {
          const videoProducer = await transport.produce({
            track: videoTrack,
            encodings: [
              { maxBitrate: 100000 },
              { maxBitrate: 300000 },
              { maxBitrate: 900000 },
            ],
            codecOptions: {
              videoGoogleStartBitrate: 1000,
            },
          });

          producerRef.current.set(videoProducer.id, videoProducer);
        }

        if (audioTrack) {
          const audioProducer = await transport.produce({
            track: audioTrack,
            codecOptions: {
              opusStereo: true,
              opusDtx: true,
              opusFec: true,
            },
          });

          producerRef.current.set(audioProducer.id, audioProducer);
        }

        hasProducedRef.current = true;
        setIsPublishing(true);
        setStatusLabel("Live and publishing to the room.");
      } catch (err) {
        console.error("produce failed", err);
        setCameraState("error");
        setIsPublishing(false);
        setCameraError("Your preview is ready, but publishing failed. Please refresh and retry.");
        setStatusLabel("Publishing failed");
      }
    };

    produce();
  }, [cameraState, sendTransportReady]);

  const guestCount = Math.max(participantIds.length - 1, 0);
  const sessionState = isPublishing
    ? "Live"
    : roomChecked && deviceLoaded && sendTransportReady && receiveTransportReady
      ? "Ready"
      : "Connecting";
  const cameraLabel =
    cameraState === "live"
      ? "Camera live"
      : cameraState === "starting"
        ? "Starting..."
        : cameraState === "error"
          ? "Retry camera"
          : "Start camera & mic";
  const recordingLabel =
    recordingState === "recording"
      ? "Stop rec"
      : recordingState === "processing"
        ? "Finishing..."
        : "Start rec";
  const uploadLabel =
    uploadState === "uploading"
      ? "Uploading"
      : uploadState === "uploaded"
        ? "Uploaded"
        : uploadState === "error"
          ? "Retry"
          : "Idle";
  const guestRecordingIndexByPeerId = new Map(
    hostRecordings
      .filter((recording) => recording.role === "guest")
      .map((recording, index) => [recording.peerId, index + 1])
  );

  return (
    <main className="min-h-screen px-4 py-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1600px]">
        <header className="panel-surface rounded-[28px] p-4 sm:p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-300/18 bg-sky-400/12 text-sm font-semibold text-sky-100">
                RS
              </div>
              <div>
                <h1 className="text-xl font-semibold text-white sm:text-2xl">RemoteStudio</h1>
                <p className="code-text mt-1 text-xs tracking-[0.22em] text-slate-400">
                  {roomId}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="status-pill rounded-full px-3 py-2 text-xs font-medium text-slate-200">
                {guestCount} guest{guestCount === 1 ? "" : "s"}
              </div>
              <div className="status-pill rounded-full px-3 py-2 text-xs font-medium text-slate-200">
                {sessionState}
              </div>
              <button
                type="button"
                onClick={copyRoomId}
                className="field-shell rounded-full px-4 py-2 text-sm font-medium text-white transition hover:border-sky-300/30"
              >
                {copied ? "Copied" : "Copy ID"}
              </button>
              <button
                type="button"
                onClick={startCamera}
                disabled={cameraState === "starting"}
                className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-emerald-400/60"
              >
                {cameraLabel}
              </button>
              <button
                type="button"
                onClick={() => toggleLocalMedia("audio")}
                disabled={cameraState !== "live"}
                className="field-shell rounded-full px-4 py-2 text-sm font-medium text-white transition hover:border-sky-300/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isMicEnabled ? "Mute" : "Unmute"}
              </button>
              <button
                type="button"
                onClick={() => toggleLocalMedia("video")}
                disabled={cameraState !== "live"}
                className="field-shell rounded-full px-4 py-2 text-sm font-medium text-white transition hover:border-sky-300/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isVideoEnabled ? "Hide cam" : "Show cam"}
              </button>
              <button
                type="button"
                onClick={recordingState === "recording" ? stopLocalRecording : startLocalRecording}
                disabled={
                  !recordingSupported ||
                  cameraState !== "live" ||
                  recordingState === "processing" ||
                  !uploadToken
                }
                className="rounded-full bg-rose-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-rose-300 disabled:cursor-not-allowed disabled:bg-rose-400/40 disabled:text-slate-200"
              >
                {recordingLabel}
              </button>
              {recordingUrl && (
                <button
                  type="button"
                  onClick={downloadLocalRecording}
                  className="field-shell rounded-full px-4 py-2 text-sm font-medium text-white transition hover:border-sky-300/30"
                >
                  Save local
                </button>
              )}
              {recordingUrl && uploadState === "error" && (
                <button
                  type="button"
                  onClick={() => void retryRecordingUpload()}
                  className="field-shell rounded-full px-4 py-2 text-sm font-medium text-white transition hover:border-sky-300/30"
                >
                  Retry upload
                </button>
              )}
              <button
                type="button"
                onClick={leaveRoom}
                className="rounded-full border border-white/10 bg-white/6 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
              >
                Leave
              </button>
            </div>
          </div>
        </header>

        {cameraError && (
          <div className="mt-4 rounded-2xl border border-rose-300/18 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            {cameraError}
          </div>
        )}

        {recordingError && (
          <div className="mt-4 rounded-2xl border border-amber-300/18 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            {recordingError}
          </div>
        )}

        {uploadError && (
          <div className="mt-4 rounded-2xl border border-rose-300/18 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            {uploadError}
          </div>
        )}

        <section className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <section className="panel-surface rounded-[32px] p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3 pb-4">
              <h2 className="text-sm font-medium uppercase tracking-[0.24em] text-slate-300">
                Guest Feed
              </h2>
              <span className="text-sm text-slate-400">
                {remoteVideoIds.length > 0
                  ? `${remoteVideoIds.length} live`
                  : guestCount > 0
                    ? "Joined"
                    : "Waiting"}
              </span>
            </div>

            {remoteVideoIds.length > 0 ? (
              <div
                className={`grid gap-4 ${
                  remoteVideoIds.length === 1 ? "grid-cols-1" : "md:grid-cols-2"
                }`}
              >
                {remoteVideoIds.map((producerId, index) => (
                  <div
                    key={producerId}
                    className="overflow-hidden rounded-[28px] border border-white/10 bg-slate-950 rounded-xl"
                  >
                    <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                      <span className="text-sm font-medium text-white">
                        Guest {index + 1}
                      </span>
                      <span className="text-xs font-medium text-emerald-200">Live</span>
                    </div>
                   <div className=" aspect-square rounded-2xl">
                     <video
                      ref={(element) => attachVideoRef(producerId, element)}
                      className="min-h-[260px] w-full object-cover "
                      playsInline
                      muted
                      autoPlay
                    />
                   </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-[460px] items-center justify-center rounded-[28px] border border-dashed border-white/12 bg-slate-950/70 sm:min-h-[560px]">
                <div className="text-center">
                  <p className="text-lg font-medium text-white">
                    {guestCount > 0 ? "Guest joined" : "Waiting for guest"}
                  </p>
                  <p className="mt-2 text-sm text-slate-400">{statusLabel}</p>
                </div>
              </div>
            )}
          </section>

          <aside className="grid gap-4">
            <section className="panel-surface rounded-[32px] p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3 pb-4">
                <h2 className="text-sm font-medium uppercase tracking-[0.24em] text-slate-300">
                  Your Feed
                </h2>
                <span className="text-sm text-slate-400">
                  {cameraState === "live" ? "Live" : "Standby"}
                </span>
              </div>

              <div className="relative overflow-hidden rounded-[28px] border border-white/10 bg-slate-950">
                <video
                  ref={localVideoRef}
                  className={`min-h-[460px] w-full object-cover transition sm:min-h-[560px] ${
                    cameraState === "live" && isVideoEnabled ? "opacity-100" : "opacity-0"
                  }`}
                  style={{ transform: "scaleX(-1)" }}
                  playsInline
                  muted
                  autoPlay
                />
                {(cameraState !== "live" || !isVideoEnabled) && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <p className="text-sm text-slate-400">Camera off</p>
                  </div>
                )}
              </div>
            </section>

            <section className="panel-surface rounded-[32px] p-4">
              <div className="flex flex-wrap gap-2">
                <div className="status-pill rounded-full px-3 py-2 text-xs font-medium text-slate-200">
                  {statusLabel}
                </div>
                <div className="status-pill rounded-full px-3 py-2 text-xs font-medium text-slate-200">
                  Audio {remoteAudioCount}
                </div>
                <div className="status-pill rounded-full px-3 py-2 text-xs font-medium text-slate-200">
                  Video {remoteVideoIds.length}
                </div>
                <div className="status-pill rounded-full px-3 py-2 text-xs font-medium text-slate-200">
                  Rec {recordingState === "recording" ? "On" : recordingState === "ready" ? "Ready" : recordingState === "processing" ? "Saving" : "Off"}
                </div>
                <div className="status-pill rounded-full px-3 py-2 text-xs font-medium text-slate-200">
                  Upload {uploadLabel}
                </div>
                <div className="status-pill rounded-full px-3 py-2 text-xs font-medium text-slate-200">
                  Chunks {uploadedChunkCount}/{totalChunkCount}
                </div>
                <div className="status-pill rounded-full px-3 py-2 text-xs font-medium text-slate-200">
                  Master {formatDuration(recordingDurationSeconds)}
                </div>
                {recordingSize > 0 && (
                  <div className="status-pill rounded-full px-3 py-2 text-xs font-medium text-slate-200">
                    {formatFileSize(recordingSize)}
                  </div>
                )}
              </div>
            </section>

            {isHost && (
              <section className="panel-surface rounded-[32px] p-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium uppercase tracking-[0.24em] text-slate-300">
                    Session Masters
                  </h2>
                  <span className="text-sm text-slate-400">
                    {hostRecordings.length} uploaded
                  </span>
                </div>

                <div className="mt-4 space-y-3">
                  {hostRecordings.length > 0 ? (
                    hostRecordings.map((recording) => (
                      <div
                        key={recording.id}
                        className="panel-muted flex items-center justify-between gap-3 rounded-[24px] p-4"
                      >
                        <div>
                          <p className="text-sm font-medium text-white">
                            {getRecordingLabel(recording, guestRecordingIndexByPeerId)}
                          </p>
                          <p className="mt-1 text-xs text-slate-400">
                            {formatDuration(recording.durationSeconds)} ·{" "}
                            {formatFileSize(recording.size)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void downloadHostRecording(recording)}
                          disabled={downloadingRecordingId === recording.id}
                          className="field-shell rounded-full px-4 py-2 text-sm font-medium text-white transition hover:border-sky-300/30 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {downloadingRecordingId === recording.id ? "Loading..." : "Download"}
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="panel-muted rounded-[24px] p-4">
                      <p className="text-sm text-slate-300">
                        {isLoadingRecordings
                          ? "Checking for uploaded masters..."
                          : "When each participant stops recording, their local master will appear here."}
                      </p>
                    </div>
                  )}
                </div>
              </section>
            )}
          </aside>
        </section>
      </div>
    </main>
  );
}
