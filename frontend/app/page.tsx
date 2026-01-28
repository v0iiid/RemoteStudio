"use client"

import axios from "axios"
import { useState } from "react"
import { useRouter } from "next/navigation"

export default function Home() {
  const [roomId, setRoomId] = useState<string>('')
  const [joinId,setJoinId] =  useState<string>('')
  const router = useRouter();
  const createRoom = async () => {
    console.log("called")
    const res = await axios.post("https://10.200.30.193:8000/api/createRoom")
    const data = res.data;
    setRoomId(data.roomId)
  }
  const joinRoom = () => {
    if (!joinId) {
      alert("Please create a room first!")   // show message if empty
      return
    }

    router.push(`/room/${joinId}`)
  }

  return (
    <div className="mx-10">
      <button
        onClick={() => createRoom()}
        className="bg-blue-400 px-2 py-1 text-sm text-white mt-20 cursor-pointer hover:bg-blue-500">create room</button>
      <p className="text-white pt-2">roomId:{roomId}</p>
      <button
        onClick={joinRoom}
        className="bg-green-400 hover:bg-green-500 text-white mt-5 cursor-pointer px-2 py-1 text-sm"
      >
        Join Room
      </button>
      <input className="px-2 text-white outline-none mx-2" onChange={(e)=>setJoinId(e.target.value)} value={joinId} placeholder="room id" type="text"  />

    </div>
  )
}
