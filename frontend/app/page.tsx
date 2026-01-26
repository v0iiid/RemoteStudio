"use client"
import * as mediasoupClient from 'mediasoup-client';
import { Consumer, Producer, Transport, TransportOptions } from 'mediasoup-client/types';
import { useEffect, useRef, useState } from 'react';

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [remoteProducerIds, setremoteProducterIds] = useState<string[] | null>([])
  const [loaded, setLoaded] = useState(false);
  const [publish, setPublish] = useState(false);
  const producerTransportRef = useRef<Transport | null>(null)
  const consumerTransportRef = useRef<Transport | null>(null)
  const hasProducedRef = useRef<boolean>(false);
  const producerRef = useRef<Producer | null>(null)
  const consumerRef = useRef<Map<string, Consumer>>(new Map())

  let produceCallback: ((data: { id: string }) => void) | null = null;
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8081');
    socketRef.current = ws;
    const device = new mediasoupClient.Device();
    deviceRef.current = device;

    ws.onopen = () => {
      console.log('WebSocket connected');
      ws.send(JSON.stringify({ type: "create-room" }));
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data)
      console.log("type->", data.type)
      switch (data.type) {
        case "room-created":
          ws.send(JSON.stringify({
            type: "join-room",
            roomId: data.roomId,
          }));
          ws.send(JSON.stringify({ type: 'getRtpCapabilities' }));
          break;
        // case "joined-room":
        //   console.log("joined room:", data.roomId);
        //   ws.send(JSON.stringify({ type: 'getRtpCapabilities' }));
        //   break;

        case "rtpCapabilities":
          try {
            await device.load({ routerRtpCapabilities: data.rtpCapabilities })
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
              id: data.id,
              iceParameters: data.iceParameters,
              iceCandidates: data.iceCandidates,
              dtlsParameters: data.dtlsParameters,
              sctpParameters: data.sctpParameters
            })

            producerTransport.on("connect", async ({ dtlsParameters }, callback) => {
              try {
                console.log("calling connect")
                ws.send(JSON.stringify({
                  type: "transport-connect",
                  data: {
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
                console.log("calling produce")
                const ws = socketRef.current;
                if (!ws) return;

                produceCallback = callback;

                ws.send(JSON.stringify({
                  type: "transport-produce",
                  data: {
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
            id: data.id,
            iceParameters: data.iceParameters,
            iceCandidates: data.iceCandidates,
            dtlsParameters: data.dtlsParameters,
            sctpParameters: data.sctpParameters
          })
          consumerTransportRef.current = consumerTransport;

          consumerTransport.on("connect", async ({ dtlsParameters }, callback) => {
            try {
              ws.send(JSON.stringify({
                type: "consumer-connect",
                data: { transportId: consumerTransport.id, dtlsParameters }
              }));
              callback();
            } catch (err) {
              console.log(err);
            }
          });

          consumerTransport.on("connectionstatechange", (state) => {
            console.log("Consumer transport state:", state);

            if (state === "connected") {
              socketRef.current?.send(
                JSON.stringify({ type: "consumer-ready" })
              );
            }
          });
          consumerTransport.on('connectionstatechange', (state) => {
            console.log('TRANSPORT STATE →', state);
          });

          ws.send(JSON.stringify({
            type: "consume",
            data: { rtpCapabilities: device.rtpCapabilities }
          }));
          break;

        case "produce-data":
          produceCallback?.({ id: data.id });
          produceCallback = null;
          console.log("Producer confirmed:", data.id);
          break;

        case "newConsumer":
          (async () => {
            const consumerTransport = consumerTransportRef.current!;

            const consumer = await consumerTransport.consume({
              id: data.id,
              producerId: data.producerId,
              kind: data.kind,
              rtpParameters: data.rtpParameters,
            });

            consumerRef.current.set(data.producerId, consumer)

            await consumer.resume();

            const track = consumer.track;

            if (track.muted) {
              await new Promise<void>((resolve) => {
                track.onunmute = () => resolve();
              });
            }

            const stream = new MediaStream([track]);

            const video = remoteVideoRef.current.get(data.producerId)
            if (!video) {
              console.warn("Video element for producer not found:", data.producerId);
              return;
            };
            video.srcObject = stream;
            video.muted = true;
            await video.play();

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
      producerRef.current?.close();
      consumerRef.current.forEach(c => c.close());
      producerTransportRef.current?.close();
      consumerTransportRef.current?.close();
      producerTransportRef.current?.close()
      localVideoRef.current?.pause()

      console.log('WebSocket closed')
    }
  }, [])

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

      producerRef.current = producer
      hasProducedRef.current = true
    }
    if (!hasProducedRef.current) {
      produce()
    }
  }, [publish])

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
              ref={el => attachVideoRef(producerId,el)}
              playsInline
              muted
              controls
              width={400}
              height={200} />
          ))}



        </div>
      </div>
    </div>
  </div>;
}
