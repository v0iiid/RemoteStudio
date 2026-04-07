"use client";

import { ServerToClientMessage } from "@/app/types/ws-types";
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

const addUniqueId = (items: string[], nextId: string) =>
  items.includes(nextId) ? items : [...items, nextId];

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

  const { roomId } = useParams<{ roomId: string }>();
  const router = useRouter();

  const [remoteVideoIds, setRemoteVideoIds] = useState<string[]>([]);
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [roomChecked, setRoomChecked] = useState(false);
  const [deviceLoaded, setDeviceLoaded] = useState(false);
  const [sendTransportReady, setSendTransportReady] = useState(false);
  const [receiveTransportReady, setReceiveTransportReady] = useState(false);
  const [remoteAudioCount, setRemoteAudioCount] = useState(0);
  const [isPublishing, setIsPublishing] = useState(false);
  const [cameraState, setCameraState] = useState<
    "idle" | "starting" | "live" | "error"
  >("idle");
  const [cameraError, setCameraError] = useState("");
  const [statusLabel, setStatusLabel] = useState("Checking room...");
  const [copied, setCopied] = useState(false);

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

  async function startCamera() {
    if (cameraState === "starting" || cameraState === "live") {
      return;
    }

    try {
      setCameraError("");
      setStatusLabel("Requesting camera and microphone...");
      setCameraState("starting");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        await localVideoRef.current.play().catch(() => {});
      }

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
    if (!roomId) {
      return;
    }

    let isMounted = true;
    const localVideoElement = localVideoRef.current;
    const producerMap = producerRef.current;
    const consumerMap = consumerRef.current;
    const audioMap = audioRefs.current;
    const remoteVideoMap = remoteVideoRef.current;

    const connectWebSocket = () => {
      const ws = new WebSocket("wss://localhost:8000/");

      socketRef.current = ws;
      deviceRef.current = new mediasoupClient.Device();

      ws.onopen = () => {
        setStatusLabel("Joining room...");
        ws.send(
          JSON.stringify({
            type: "join-room",
            payload: { joinRoomId: roomId },
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
            setParticipantIds([parsed.payload.peerId, ...parsed.payload.existingPeerIds]);
            setStatusLabel(
              parsed.payload.existingPeerIds.length > 0 ? "Guest joined" : "Studio connected"
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
                  errback(err);
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
        await axios.get(`https://localhost:8000/api/rooms/${roomId}`);

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
  }, [handleNewConsumer, removeRemoteProducer, roomId, router]);

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
                onClick={() => router.push("/")}
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
                    className="overflow-hidden rounded-[28px] border border-white/10 bg-slate-950"
                  >
                    <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                      <span className="text-sm font-medium text-white">
                        Guest {index + 1}
                      </span>
                      <span className="text-xs font-medium text-emerald-200">Live</span>
                    </div>
                    <video
                      ref={(element) => attachVideoRef(producerId, element)}
                      className="min-h-[460px] w-full object-cover sm:min-h-[560px]"
                      playsInline
                      muted
                      autoPlay
                    />
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
                    cameraState === "live" ? "opacity-100" : "opacity-0"
                  }`}
                  style={{ transform: "scaleX(-1)" }}
                  playsInline
                  muted
                  autoPlay
                />
                {cameraState !== "live" && (
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
              </div>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}
