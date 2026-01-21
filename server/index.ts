import express from "express";

const app = express();
const PORT =5000;

app.get("/",(req,res)=>{
 res.send("hello")
})

app.listen(PORT,()=>{console.log("Server starting at  port 5000")})
