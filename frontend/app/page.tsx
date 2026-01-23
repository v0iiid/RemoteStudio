"use client"
import * as mediasoupClient from 'mediasoup-client';
import { Transport, TransportOptions } from 'mediasoup-client/types';
import { useEffect, useRef, useState } from 'react';

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [publish, setPublish] = useState(false);
  const transportRef = useRef<Transport | null>(null)
  const hasProducedRef = useRef<boolean>(false);


  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8081');
    socketRef.current = ws;
    const device = new mediasoupClient.Device();
    deviceRef.current = device;

    ws.onopen = () => {
      console.log('WebSocket connected');
      ws.send(JSON.stringify({ type: 'getRtpCapabilities' }));
    };

    ws.onmessage = async (event) => {

      const data = JSON.parse(event.data)
      console.log("type->", data.type)
      switch (data.type) {

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
            const transport = device.createSendTransport<TransportOptions>({
              id: data.id,
              iceParameters: data.iceParameters,
              iceCandidates: data.iceCandidates,
              dtlsParameters: data.dtlsParameters,
              sctpParameters: data.sctpParameters
            })

            transport.on("connect", async ({ dtlsParameters }) => {
              console.log("sending connect")
              try {
                console.log("dtls", dtlsParameters)
                ws.send(JSON.stringify({
                  type: "transport-connect",
                  data: {
                    transportId: transport.id,
                    dtlsParameters
                  }
                }))
              } catch (err: any) {
                console.warn('error at connect')
              }
            })
            transport.on("produce", (parameters) => {
              try {
                console.log("inside produce")
                const ws = socketRef.current
                if (!ws) return
                console.log("sending produce")
                ws.send(JSON.stringify({
                  type: "transport-produce",
                  data: {
                    transportId: transport.id,
                    kind: parameters.kind,
                    rtpParameters: parameters.rtpParameters,
                    appData: parameters.appData
                  }
                }))
              } catch (err) {
                console.log("error at produce", err)
              }
            })
            transport.on("producedata", (parameters) => {
              ws.send(JSON.stringify({
                type: "transport-producedata",
                data: {
                  transportId: transport.id,
                  sctpStreamParameters: parameters.sctpStreamParameters,
                  label: parameters.label,
                  protocol: parameters.protocol
                }
              }))
            })
            transportRef.current = transport
          } catch (err: any) {
            console.log("error in createTransport", err)
          }
          break;
        case "consumerTransportCreated":
          device.createRecvTransport({
            id: data.id,
            iceParameters: data.iceParameters,
            iceCandidates: data.iceCandidates,
            dtlsParameters: data.dtlsParameters,
            sctpParameters: data.sctpParameters

          })
          break
        case "consumerCreated":
      }
    };
    ws.onerror = (err) => {
      console.error('WebSocket error', err);
    };

    return () => {
      ws.close();
      transportRef.current?.close()
      localVideoRef.current?.pause();
      console.log('WebSocket closed')
    }
  }, [])

  useEffect(() => {
    const transport = transportRef.current;
    if (!transport) return
    if (!localVideoRef.current?.srcObject) return
    const stream: MediaStream = localVideoRef.current.srcObject as MediaStream
    const videoTrack = stream.getVideoTracks()[0];
    const produce = async () => {

      await transport.produce(
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
    <div className='flex '>
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
            if (transportRef.current && stream) {
              setPublish(true)
            }

          }
          }
        >Start Camera</button>
        <div className='my-20 mx-44 bg-black w-fit rounded-xl'>
          <video
            className='rounded-xl'
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            width={400}
            height={200} />
        </div>
      </div>
      <div>
        <button
          onClick={() => {
            const ws = socketRef.current;
            if (!ws) return
            ws.send(JSON.stringify({ type: "create-consumerTransport" }))
          }}
          className='bg-sky-400 text-white px-2 py-1 text-sm cursor-pointer rounded-lg'>Consume</button>
      </div>
    </div>
  </div>;
}
