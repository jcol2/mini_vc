declare const CertFingerprint: string;
let wt: WebTransport;

async function
HandleData(receiveStream: any)
{
 const reader = receiveStream.getReader();
 for (;;)
 {
  console.log("[recv] strm wait");
  const {done, value} = await reader.read();
  if (done)
  {
   break;
  }
  console.log(value);
 }

 console.log("[recv] done with strm");
}

async function
HandleMsg(Msg: { data: any})
{
 const hashBytes: Uint8Array = Uint8Array.fromHex(CertFingerprint);
 wt = new WebTransport(
  "https://127.0.0.1:4567/",
  {
   allowPooling: false,
   serverCertificateHashes: [
    {
     algorithm: "sha-256",
     value: hashBytes.buffer as BufferSource,
    },
   ],
  }
 );
 await wt.ready;

 const reader = wt.incomingUnidirectionalStreams.getReader();

 for (;;)
 {
  console.log("[recv] wait");
  const {done, value} = await reader.read();
  if (done)
  {
   break;
  }
  await HandleData(value);
 }
 console.log("[recv] exited");
}

onmessage = HandleMsg;

export {};