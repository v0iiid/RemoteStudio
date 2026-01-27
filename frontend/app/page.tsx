"use client"

import axios from "axios"
import { useState } from "react"

export default function Home() {
  const [roomId,setRoomId] = useState<string>('')
  const createRoom = async () => {
    console.log("called")
    const res = await axios.post("http://localhost:8000/api/createRoom")
    const data = res.data;
    setRoomId(data.roomId)
  }
  return (
    <div className="mx-10">
      <button
      onClick={()=>createRoom()}
      className="bg-blue-400 px-2 py-1  rounded-sm text-sm text-white mt-20 cursor-pointer hover:bg-blue-500">create room</button>
      <p className="text-white pt-2">roomId:{roomId}</p>
    </div>
  )
}
