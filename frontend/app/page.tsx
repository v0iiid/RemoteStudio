"use client"
import * as mediasoupClient from 'mediasoup-client';
import { useEffect, useState } from 'react';

export default function Home() {
  const [socket, setSocket] = useState<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8080');

    ws.onopen = () => {
      console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
      console.log('Message:', event.data);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error', err);
    };
    setSocket(ws)
    return () => {
      ws.close();
      console.log('WebSocket closed')
    }
  }, [])
  let device: mediasoupClient.Device;

  try {
    device = new mediasoupClient.Device();
  }
  catch (error) {
    if ((error as any).name === 'UnsupportedError')
      console.warn('browser not supported');
  }


  return <div className="font-medium p-2 text-xl text-green-500">
    <p>Show Logs</p>
    <button
      onClick={() => {
        console.log(device.handlerName)
        console.log(device.loaded)
      }}
      className="bg-sky-400 py-1 px-2 border border-blue-500 text-white/90 text-sm rounded-sm cursor-pointer"
    >
      Click
    </button>
  </div>;
}
