import { frameHeaderLn, FrameHeaderWrite, sendOrderDefault, sendOrderKeyframe } from "./util";

interface worker_msg
{
 data:
 {
  recvPort: MessagePort;
  vcapPort: MessagePort;
 };
};

interface vcap_msg
{
 data:
 {
  chunk: EncodedVideoChunk;
 };
};

declare const CertFingerprint: string;
let wt: WebTransport;
let wtInit = 0;
let frameId = 0;


async function 
WebTransportAlloc(): Promise<WebTransport>
{
 wtInit = 0;
 const hashBytes: Uint8Array = Uint8Array.fromHex(CertFingerprint);
 const ret = new WebTransport(
  "https://127.0.0.1:4567/",
  {
   allowPooling: false,
   serverCertificateHashes:
   [
    {
     algorithm: "sha-256",
     value: hashBytes.buffer as BufferSource,
    },
   ],
  }
 );
 await ret.ready;
 wtInit = 1;
 return ret;
}

function
RecvMsgCb(msg: any) //todo not sure if recv will send msg
{

}

async function
VcapMsgCb(msg: vcap_msg)
{
 if (wt && wtInit)
 {
  const chunk = msg.data.chunk;

  const isKey = chunk.type == "key" ? 1 : 0;
  const buf = new Uint8Array(frameHeaderLn + chunk.byteLength);
  chunk.copyTo(buf.subarray(frameHeaderLn));
  const view = new DataView(buf.buffer);
  FrameHeaderWrite(view, frameId, chunk.timestamp, 0, isKey); //todo proper trackid

 // console.log("[vcap] Sending length: ", buf.length);

  const writeStream: WritableStream<any> = await wt.createUnidirectionalStream({sendOrder: isKey ? sendOrderKeyframe : sendOrderDefault});
  const writer = writeStream.getWriter();
  writer.write(buf);
  writer.releaseLock();
  writeStream.close();

  frameId++;
 }
}

async function
WorkerMsgCb(msg: worker_msg)
{
 if (wt && wtInit)
 {
  const recvPort = msg.data.recvPort;
  const vcapPort = msg.data.vcapPort;
  recvPort.onmessage = RecvMsgCb;
  vcapPort.onmessage = VcapMsgCb;

  let reader = wt.incomingUnidirectionalStreams.getReader();
  for (;;)
  {
   // console.log("[recv] wait");
   const timeout = new Promise((resolve, _) => setTimeout(() => resolve({ skip: 1 }), 5000));
   const res = await Promise.race([reader.read(), timeout]) as any;
   if (res.skip)
   {
    wtInit = 0;
    console.log('[recv] timeout - skipping');
    await reader.cancel();
    reader.releaseLock();
    wt.close();
    wt = await WebTransportAlloc();
    reader = wt.incomingUnidirectionalStreams.getReader();
    continue;
   }
   if (res.done)
   {
    break;
   }

   // on ff its a WebTransportReceiveStream
   const stream: ReadableStream = res.value;
   recvPort.postMessage({ reader: stream }, [stream]);
  }
  console.log("[net] recv loop exit");
 }
}

function
WorkerErrCb(err: any)
{
 console.error(err);
}

async function
Main()
{
 wt = await WebTransportAlloc();
 // wt.closed.finally(() => {run = 0});
 // dgramWriter = wt.datagrams.writable.getWriter();
}

onmessage = WorkerMsgCb;
onerror = WorkerErrCb;

Main();

export {};