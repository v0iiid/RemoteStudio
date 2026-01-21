"use client"
import * as mediasoupClient from 'mediasoup-client';
import { useEffect, useRef, useState } from 'react';

export default function Home() {
  const socketRef = useRef<WebSocket | null>(null);
  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const [loaded, setLoaded] = useState(false);


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

    ws.onmessage =async (event) => {

      const data = JSON.parse(event.data)

      console.log("data", data)
      if (data.type == "rtpCapabilities") {
        try{

            await device.load({ routerRtpCapabilities: data.rtpCapabilities })

           setLoaded(true)
           console.log("Device loaded:", device.handlerName);
        } catch (err: any) {
          if (err.name === "UnsupportedError") {
            console.warn("Browser not supported");
          } else {
            console.error(err);
          }
        }

      }

      console.log("\n device loaded",device.handlerName)
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
  </div>;
}
