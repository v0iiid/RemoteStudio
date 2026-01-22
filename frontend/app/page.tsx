"use client"
import * as mediasoupClient from 'mediasoup-client';
import { Transport, TransportOptions } from 'mediasoup-client/types';
import { useEffect, useRef, useState } from 'react';

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const transportRef = useRef<Transport | null>(null)

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8081');
    socketRef.current = ws;
    const newDevice = new mediasoupClient.Device();
    const device = new mediasoupClient.Device();
    deviceRef.current = device;

    ws.onopen = () => {
      console.log('WebSocket connected');
      ws.send(JSON.stringify({ type: 'getRtpCapabilities' }));
    };

    ws.onmessage = async (event) => {

      const data = JSON.parse(event.data)

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
            const params = data.dtlsParameters
            transport.on("connect", async ({ dtlsParameters }) => {
              try {
                ws.send(JSON.stringify({
                  type: "transport-connect",
                  data: {
                    transportId: transport.id,
                    dtlsParameters: dtlsParameters
                  }
                }))
              } catch (err: any) {
                console.warn('error at connect')
              }
            })

            transportRef.current = transport
          } catch (err: any) {
            console.log("error in createTransport", err)
          }
      }
    };
    ws.onerror = (err) => {
      console.error('WebSocket error', err);
    };

    return () => {
      ws.close();
      console.log('WebSocket closed')
    }
  }, [])

  return <div className="font-medium p-2 text-xl text-green-500">
    <p>Show Logs</p>
    <button
      onClick={() => {
        const device = deviceRef.current;
        if (!device) return;
        console.log(device.handlerName)
        console.log(device.loaded)
      }}
      className="bg-sky-400 py-1 px-2 border border-blue-500 text-white/90 text-sm rounded-sm cursor-pointer"
    >
      Click
    </button>
    <button
      className='px-2 py-1 bg-green-400 text-white/90 rounded m-4 text-sm cursor-pointer'
      onClick={async () => {
        console.log("preseed")
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const videoTrack = stream.getVideoTracks()[0];
        const transport = transportRef.current
        if (transport) {
             transport.on("produce", (parameters) => {
              try {
                const ws =socketRef.current
                if(!ws) return
                ws.send(JSON.stringify({
                  type:"transport-produce",
                  data:{
                    transportId: transport.id,
                    kind: parameters.kind,
                    rtpParameters: parameters.rtpParameters,
                    appData: parameters.appData
              }}))
              } catch (err) {
                console.log("error at produce", err)
              }
            })
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
        }
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          await localVideoRef.current.play();

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
  </div>;
}
