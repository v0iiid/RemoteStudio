"use client"
import { ServerToClientMessage } from '@/app/types/ws-types';
import * as mediasoupClient from 'mediasoup-client';
import { Consumer, Producer, Transport, TransportOptions } from 'mediasoup-client/types';
import { useEffect, useRef, useState } from 'react';

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const [roomIdInput, setRoomIdInput] = useState("");
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [remoteProducerIds, setremoteProducerIds] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false);
  const [publish, setPublish] = useState(false);
  const producerTransportRef = useRef<Transport | null>(null)
  const consumerTransportRef = useRef<Transport | null>(null)
  const hasProducedRef = useRef<boolean>(false);
  const producerRef = useRef<Map<string, Producer>>(new Map())
  const consumerRef = useRef<Map<string, Consumer>>(new Map())

  let produceCallback: ((data: { id: string }) => void) | null = null;
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8081');
    socketRef.current = ws;
    const device = new mediasoupClient.Device();
    deviceRef.current = device;

    ws.onopen = () => {
      console.log('WebSocket connected');
    };

    ws.onmessage = async (message) => {
      const parsed: ServerToClientMessage = JSON.parse(message.data.toString())
      console.log("type->", parsed.type)
      switch (parsed.type) {
        case "room-created":
          ws.send(JSON.stringify({
            type: "join-room",
            payload: { joinRoomId: parsed.payload.roomId },
          }));
          ws.send(JSON.stringify({ type: 'getRtpCapabilities' }));
          break;

        case "joined-room":
          ws.send(JSON.stringify({ type: 'getRtpCapabilities' }));
          break;

        case "rtpCapabilities":
          try {

            await device.load({ routerRtpCapabilities: parsed.payload.rtpCapabilities })
            setLoaded(true)
            ws.send(JSON.stringify({ type: "createTransport" }));
          } catch (err: any) {
            if (err.name === "UnsupportedError") {
              console.warn("Browser not supported");
            } else {
              console.error(err);
            }
          };
          break;

        case "transportCreated":
          try {
            const producerTransport = device.createSendTransport<TransportOptions>({
              id: parsed.payload.id,
              iceParameters: parsed.payload.iceParameters,
              iceCandidates: parsed.payload.iceCandidates,
              dtlsParameters: parsed.payload.dtlsParameters,
              sctpParameters: parsed.payload.sctpParameters
            })

            producerTransport.on("connect", async ({ dtlsParameters }, callback) => {
              try {

                ws.send(JSON.stringify({
                  type: "transport-connect",
                  payload: {
                    transportId: producerTransport.id,
                    dtlsParameters
                  }
                }))
                callback();
              } catch (err: any) {
                console.warn('error at connect')
              }
            })
            producerTransport.on("produce", (parameters, callback, errback) => {
              try {

                const ws = socketRef.current;
                if (!ws) return;

                produceCallback = callback;

                ws.send(JSON.stringify({
                  type: "transport-produce",
                  payload: {
                    transportId: producerTransport.id,
                    kind: parameters.kind,
                    rtpParameters: parameters.rtpParameters,
                    appData: parameters.appData
                  }
                }));
              } catch (err: any) {
                errback(err);
              }
            });
            producerTransport.on('connectionstatechange', (state) => {
              console.log('TRANSPORT STATE →', state);
            });

            producerTransportRef.current = producerTransport
          } catch (err: any) {
            console.log("error in createTransport", err)
          }
          break;

        case "consumerTransportCreated":
          const consumerTransport = device.createRecvTransport({
            id: parsed.payload.id,
            iceParameters: parsed.payload.iceParameters,
            iceCandidates: parsed.payload.iceCandidates,
            dtlsParameters: parsed.payload.dtlsParameters,
            sctpParameters: parsed.payload.sctpParameters
          })
          consumerTransportRef.current = consumerTransport;

          consumerTransport.on("connect", async ({ dtlsParameters }, callback) => {
            try {
              console.log("called connected")
              ws.send(JSON.stringify({
                type: "consumer-connect",
                payload: { transportId: consumerTransport.id, dtlsParameters }
              }));
              callback();
            } catch (err) {
              console.log(err);
            }
          });

          consumerTransport.on("connectionstatechange", (state) => {

            if (state === "connected") {
              console.log("is connected")
            }
          });

          ws.send(JSON.stringify({
            type: "consume",
            payload: { rtpCapabilities: device.rtpCapabilities }
          }));
          break;

        case "produce-data":
          produceCallback?.({ id: parsed.payload.id });
          produceCallback = null;
          break;

        case "newConsumer":
          (async () => {
            setremoteProducerIds(prev => {
              if (!prev?.includes(parsed.payload.producerId)) {
                return [...prev, parsed.payload.producerId]
              }
              return prev
            })

            const consumerTransport = consumerTransportRef.current!;

            const consumer = await consumerTransport.consume({
              id: parsed.payload.id,
              producerId: parsed.payload.producerId,
              kind: parsed.payload.kind,
              rtpParameters: parsed.payload.rtpParameters,
            });

            await waitForTransportConnected(consumerTransport);

            console.log("Consumer created:", consumer);
            console.log("Track state:", consumer.track.readyState);
            console.log("Consumer track ready:", consumer.track);
            console.log("Track kind:", consumer.track.kind);
            console.log("Track muted:", consumer.track.muted);
            console.log("Track enabled:", consumer.track.enabled);
            consumerRef.current.set(parsed.payload.producerId, consumer)
            attachConsumerToVideo(parsed.payload.producerId);
            await consumer.resume();
            socketRef.current?.send(
              JSON.stringify({ type: "consumer-ready", payload: { consumerId: consumer.id } })
            );
            const track = consumer.track;

            if (track.muted) {
              await new Promise<void>((resolve) => {
                track.onunmute = () => resolve();
              });
            }

            console.log("Remote video playing");
          })();
          break;
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error', err);
    };

    return () => {
      ws.close();
      producerRef.current.forEach(p => p.close());
      consumerRef.current.forEach(c => c.close());
      producerTransportRef.current?.close();
      consumerTransportRef.current?.close();
      remoteVideoRef.current.clear();
      localVideoRef.current?.pause()
      ws.onmessage = null;
      ws.onerror = null;
      console.log('WebSocket closed')
    }
  }, [])

  function waitForTransportConnected(transport: Transport) {
    return new Promise<void>((resolve) => {
      console.log("wait right->", transport.connectionState)
      if (transport.connectionState === "connected") return resolve();
      const handler = (state: string) => {
        if (state === "connected") {
          transport.off("connectionstatechange", handler);
          console.log(" state connected")
          resolve();
        }
      };
      transport.on("connectionstatechange", handler);
    });
  }
  useEffect(() => {
    const transport = producerTransportRef.current;

    if (!transport) return
    if (!localVideoRef.current?.srcObject) return
    const stream: MediaStream = localVideoRef.current.srcObject as MediaStream
    const videoTrack = stream.getVideoTracks()[0];
    console.log("Local video tracks", (localVideoRef.current?.srcObject as MediaStream).getVideoTracks());
    const produce = async () => {
      console.log("calling produce")
      const producer = await transport.produce(
        {
          track: videoTrack,
          encodings:
            [
              { maxBitrate: 100000 },
              { maxBitrate: 300000 },
              { maxBitrate: 900000 }
            ],
          codecOptions:
          {
            videoGoogleStartBitrate: 1000
          }
        });

      producerRef.current.set(producer.id, producer)
      hasProducedRef.current = true
    }
    if (!hasProducedRef.current) {
      produce()
    }
  }, [publish])



  function attachVideoRef(producerId: string, el: HTMLVideoElement | null) {
    if (!remoteVideoRef.current) return;

    if (el) {
      remoteVideoRef.current.set(producerId, el);
    } else {
      remoteVideoRef.current.delete(producerId);
    }
  }
  function attachConsumerToVideo(producerId: string) {
    const videoEl = remoteVideoRef.current.get(producerId);
    const consumer = consumerRef.current.get(producerId);

    if (!videoEl || !consumer) return;

    if (!videoEl.srcObject) {
      const stream = new MediaStream([consumer.track]);
      videoEl.srcObject = stream;
      videoEl.play().catch(() => { });
      console.log("🎥 Attached stream to video for producer", producerId);
    }
  }

  return <div className="font-medium p-2 text-xl text-green-500">
    <p>Show Logs</p>
    <button
      className="bg-sky-400 py-1 px-2 border border-blue-500 text-white/90 text-sm rounded-sm cursor-pointer"
    >
      Click
    </button>
    <div className='flex'>
      <div>
        <button
          className='px-2 py-1 bg-green-400 text-white/90 rounded m-4 text-sm cursor-pointer'
          onClick={async () => {
            console.log("preseed")
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            if (localVideoRef.current) {
              console.log("getting video")
              localVideoRef.current.srcObject = stream;
              await localVideoRef.current.play()
            }
            if (producerTransportRef.current && stream) {
              setPublish(true)
            }
          }}>
          Start Camera
        </button>
        <div className='my-20 mx-44 bg-black w-fit rounded-xl'>
          <video
            className='rounded-xl'
            ref={localVideoRef}
            style={{ transform: "scaleX(-1)" }}
            playsInline
            muted
            controls
            width={400}
            height={200} />
        </div>
      </div>
      <div>
        <div className='flex gap-2'>
          <button
            onClick={() => {
              const ws = socketRef.current;
              if (!ws) return
              ws.send(JSON.stringify({ type: "create-consumerTransport" }))
            }}
            className='bg-sky-400 text-white px-2 py-1 text-sm cursor-pointer rounded-lg'>Consume</button>
        </div>
        <div className='my-20 mx-44 bg-black w-fit rounded-xl'>

          {remoteProducerIds!.map(producerId => (
            <video
              className='rounded-xl'
              key={producerId}
              ref={el => attachVideoRef(producerId, el)}
              playsInline
              muted
              autoPlay
              controls
              width={400}
              height={200} />
          ))}
        </div>
      </div>
    </div>
    <div>
      <input
        type="text"
        placeholder="Enter room ID"
        value={roomIdInput}
        onChange={(e) => setRoomIdInput(e.target.value)}
        className="border px-2 py-1 rounded"
      />
      <button
        className="bg-blue-500 text-white px-2 py-1 rounded ml-2 cursor-pointer"
        onClick={() => {
          if (!socketRef.current || !roomIdInput) return;
          socketRef.current.send(JSON.stringify({
            type: "join-room",
            payload: { joinRoomId: roomIdInput },
          }));
        }}
      >
        Join Room
      </button>
      <button className='bg-red-400 text-white rounded-lg px-2 py-1 ml-4 cursor-pointer'
        onClick={() => {
          const ws = socketRef.current;
          if (!ws) return
          ws.send(JSON.stringify({ type: "create-room" }));

        }}
      >Create room</button>
    </div>
  </div>;
}
