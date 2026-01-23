"use client"
import * as mediasoupClient from 'mediasoup-client';
import { Consumer, Producer, Transport, TransportOptions } from 'mediasoup-client/types';
import { useEffect, useRef, useState } from 'react';

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [publish, setPublish] = useState(false);
  const producerTransportRef = useRef<Transport | null>(null)
  const consumerTransportRef = useRef<Transport | null>(null)
  const hasProducedRef = useRef<boolean>(false);
  const producerRef = useRef<Producer | null>(null)
  const consumerRef = useRef<Consumer | null>(null)


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
            const producerTransport = device.createSendTransport<TransportOptions>({
              id: data.id,
              iceParameters: data.iceParameters,
              iceCandidates: data.iceCandidates,
              dtlsParameters: data.dtlsParameters,
              sctpParameters: data.sctpParameters
            })

            producerTransport.on("connect", async ({ dtlsParameters }) => {
              console.log("sending connect")
              try {
                console.log("dtls", dtlsParameters)
                ws.send(JSON.stringify({
                  type: "transport-connect",
                  data: {
                    transportId: producerTransport.id,
                    dtlsParameters
                  }
                }))
              } catch (err: any) {
                console.warn('error at connect')
              }
            })
            producerTransport.on("produce", (parameters) => {
              try {
                console.log("inside produce")
                const ws = socketRef.current
                if (!ws) return
                console.log("sending produce")
                ws.send(JSON.stringify({
                  type: "transport-produce",
                  data: {
                    kind: parameters.kind,
                    rtpParameters: parameters.rtpParameters,
                    appData: parameters.appData
                  }
                }))
              } catch (err) {
                console.log("error at produce", err)
              }
            })
            producerTransport.on("producedata", (parameters) => {
              ws.send(JSON.stringify({
                type: "transport-producedata",
                data: {
                  transportId: producerTransport.id,
                  sctpStreamParameters: parameters.sctpStreamParameters,
                  label: parameters.label,
                  protocol: parameters.protocol
                }
              }))
            })
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
          console.log("goinge for connect")
          consumerTransport.on("connect", async ({ dtlsParameters }) => {
            console.log("send for connect")
            try {
              ws.send(JSON.stringify({
                type: "consumer-connect",
                data: {
                  transportId: consumerTransport.id,
                  dtlsParameters: dtlsParameters
                }
              }))
            } catch (err) {
              console.log("err at consumerTransport", err)
            }
          })
          console.log("at produce")


          consumerTransportRef.current = consumerTransport;
          break
        case "consumer-connected":
          const producer = producerRef.current
          if (!producer) {
            return
          }
          ws.send(JSON.stringify({
            type: "consume",
            data: {
              id: producer.id,
              rtpCapabilities: device.rtpCapabilities
            }
          }))
          break;
        case "newConsumer":
          const consume = async () => {
            const consumerTransport = consumerTransportRef.current
            if (!consumerTransport) return;
            const consumer = await consumerTransport.consume({
              id: data.id,
              producerId: data.producerId,
              kind: data.kind,
              rtpParameters: data.rtpParameters,
            })
            consumerRef.current = consumer;
            const { track } = consumer;
            if (!remoteVideoRef.current) return
            remoteVideoRef.current.srcObject = new MediaStream([track])

          }
          consume();
          break;

      }
    };
    ws.onerror = (err) => {
      console.error('WebSocket error', err);
    };

    return () => {
      ws.close();
      producerTransportRef.current?.close()
      localVideoRef.current?.pause();
      console.log('WebSocket closed')
    }
  }, [])

  useEffect(() => {
    const transport = producerTransportRef.current;

    if (!transport) return
    if (!localVideoRef.current?.srcObject) return
    const stream: MediaStream = localVideoRef.current.srcObject as MediaStream
    const videoTrack = stream.getVideoTracks()[0];

    const produce = async () => {
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
            autoPlay
            playsInline
            muted
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
          <button
            className='bg-green-400 px-2 py-1 text-sm text-white rounded-xl cursor-pointer'
            onClick={async () => {


              if (!remoteVideoRef.current) return
              await remoteVideoRef.current.play()
            }}>Play Vid</button>
        </div>
        <div className='my-20 mx-44 bg-black w-fit rounded-xl'>

          <video
            className='rounded-xl'
            ref={remoteVideoRef}
            autoPlay
            playsInline
            muted
            width={400}
            height={200} />
        </div>
      </div>
    </div>
  </div>;
}
