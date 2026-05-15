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
let frameId = 0;

function
RecvMsgCb(msg: any) //todo not sure if recv will send msg
{

}

async function
VcapMsgCb(msg: vcap_msg)
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

function
WorkerMsgCb(msg: worker_msg)
{
 const recvPort = msg.data.recvPort;
 const vcapPort = msg.data.vcapPort;
 recvPort.onmessage = RecvMsgCb;
 vcapPort.onmessage = VcapMsgCb;
}

function
WorkerErrCb(err: any)
{
 console.error(err);
}

async function
Main()
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
 // wt.closed.finally(() => {run = 0});
 // dgramWriter = wt.datagrams.writable.getWriter();
}

onmessage = WorkerMsgCb;
onerror = WorkerErrCb;

Main();

export {};