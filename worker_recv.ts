declare const CertFingerprint: string;
interface jitter_buf_el
{
 frame: EncodedVideoChunk | null,
 frameId: number,
 timestamp: number,
 metadata: number,
};

let wt: WebTransport;
let decoder: VideoDecoder;
let canvas: OffscreenCanvas;
let ctx: OffscreenCanvasRenderingContext2D;

const jitterBufLn = 256;
const jitterBufMask = jitterBufLn - 1;
const jitterBuf: Array<jitter_buf_el> = new Array(jitterBufLn).fill(null).map(() => ({ frame: null, timestamp: 0, frameId: 0, metadata: 0 }));
let jitterBufPlayIdx = 0;
let jitterBufPlayIdxInit = 0;

async function 
WebTransportAlloc(): Promise<WebTransport>
{
 const hashBytes: Uint8Array = Uint8Array.fromHex(CertFingerprint);
 const ret = new WebTransport(
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
 await ret.ready;
 return ret;
}

async function
UnidiCb(receiveStream: any)
{
 // receive stream chunks
 const reader = receiveStream.getReader();
 const packetBuf = [];
 let catBufLn = 0;
 for (;;)
 {
  // console.log("[recv] strm wait");
  const timeout = new Promise((resolve, _) => setTimeout(() => resolve({ skip: 1 }), 1000));
  const res = await Promise.race([reader.read(), timeout]) as any;
  if (res.skip)
  {
   console.log("[recv] inner skip");
   await reader.cancel();
   reader.releaseLock();
   return;
  }
  if (res.done)
  {
   break;
  }
  packetBuf.push(res.value);
  catBufLn += res.value.length;
 }
 // console.log("[recv] my buf ln", catBufLn);

 // cat stream chunks
 let catBuf = new Uint8Array(catBufLn);
 let catBufOff = 0;
 for (let I = 0; I < packetBuf.length; ++I)
 {
  const buf = packetBuf[I];
  catBuf.set(buf, catBufOff);
  catBufOff += buf.length;
 }

 // insert into jitter buf
 const catView = new DataView(catBuf.buffer);
 const frameId = catView.getUint32(0, true);
 const timestampMs = catView.getUint32(4, true);
 const trackId = catView.getUint8(8); // todo handle multiple tracks?
 const metadata = catView.getUint8(9);
 const jitterBufWriteIdx = frameId & jitterBufMask;
 const jitterBufEl = jitterBuf[jitterBufWriteIdx];
 jitterBufEl.frameId = frameId;
 jitterBufEl.timestamp = timestampMs;
 jitterBufEl.metadata = metadata;
 
 const frameHeaderLn = 10;
 jitterBufEl.frame = new EncodedVideoChunk({
  data: new DataView(catBuf.buffer, frameHeaderLn), 
  timestamp: timestampMs, 
  type: metadata ? "key" : "delta",
  // todo specify duration
 });
 
 if (!jitterBufPlayIdxInit)
 {
  jitterBufPlayIdxInit = 1;
  jitterBufPlayIdx = jitterBufWriteIdx;
 }
 const delta = jitterBufWriteIdx >= jitterBufPlayIdx ? jitterBufWriteIdx - jitterBufPlayIdx : jitterBufLn - jitterBufPlayIdx + jitterBufWriteIdx;
 if (delta > 6)
 {
  const decodeChunk = jitterBuf[jitterBufPlayIdx];
  if (decodeChunk.frame)
  {
   decoder.decode(decodeChunk.frame);
   jitterBufPlayIdx++;
   jitterBufPlayIdx %= jitterBufMask;
  }
  else
  {
   console.error("[recv] Error no video chunk at play idx");
  }
 }
 
}

function
DecoderCb(videoFrame: VideoFrame)
{
 canvas.width = videoFrame.displayWidth;
 canvas.height = videoFrame.displayHeight;
 ctx.drawImage(videoFrame, 0, 0);
 videoFrame.close();
}

function
DecoderErrCb(err: Error)
{
 console.error(err);
}

async function
WorkerMsgCb(msg: { data: { canvas: OffscreenCanvas }})
{
 canvas = msg.data.canvas;
 ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

 // init wt
 wt = await WebTransportAlloc();
 let reader = wt.incomingUnidirectionalStreams.getReader();

 // init decoder
 decoder = new VideoDecoder({output: DecoderCb, error: DecoderErrCb});
 decoder.configure({
  codec: "vp8",
  optimizeForLatency: true,
  // todo chrome doesn't like this:
  // hardwareAcceleration: "prefer-hardware",
  // codedHeight: 720,
  // codedWidth: 1280,
 });

 for (;;)
 {
  // console.log("[recv] wait");
  const timeout = new Promise((resolve, _) => setTimeout(() => resolve({ skip: 1 }), 5000));
  const res = await Promise.race([reader.read(), timeout]) as any;
  if (res.skip)
  {
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
  await UnidiCb(res.value);
 }
 console.log("[recv] exited");
}

function
WorkerErrCb(err: any)
{
 console.error(err);
}

onmessage = WorkerMsgCb;
onerror = WorkerErrCb;

export {};