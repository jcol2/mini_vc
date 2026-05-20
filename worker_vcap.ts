import { gopHeaderLn, GopHeaderWrite, sendOrderDefault, sendOrderKeyframe, frameHeaderLn, framesPerGop, WebTransportAlloc, FrameHeaderWrite } from "./util";

export interface vcap_worker_msg
{
 readable: ReadableStream<VideoFrame | AudioData>;
};

declare const certFingerprint: string;
let wt: WebTransport;
let encoder: VideoEncoder;
let run = 1;
let stream: WritableStream | null = null;

let frameId = 0;
async function
EncoderCb(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): Promise<void>
{
 const isKey = chunk.type == "key" ? 1 : 0;
 let bufLn = frameHeaderLn + chunk.byteLength;
 let writeOff = 0;
 if (isKey)
 {
  frameId++;

  if (stream)
  {
   await stream.close();
  }
  stream = await wt.createUnidirectionalStream();
  bufLn = gopHeaderLn + frameHeaderLn + chunk.byteLength;
  // todo update stream priority
 }
 const buf = new Uint8Array(bufLn);
 const view = new DataView(buf.buffer);

 if (isKey)
 {
  writeOff = GopHeaderWrite(view, writeOff, frameId, 0, isKey); //todo proper trackid
 }
 writeOff = FrameHeaderWrite(view, writeOff, chunk.byteLength, chunk.timestamp);
 chunk.copyTo(buf.subarray(writeOff));

// console.log("[vcap] Sending length: ", buf.length);

 if (stream)
 {
  const writeStream = stream;
  const writer = writeStream.getWriter();
  await writer.write(buf);
  writer.releaseLock();
 }

 // todo old dgram code
 // const dgramLn = wt.datagrams.maxDatagramSize;
 // const bufLeftoverLn = (buf.length % dgramLn);
 // const bufRoundLn = buf.length - bufLeftoverLn;
 // let i = 0;
 // while (i < bufRoundLn)
 // {
 //  const i_next = i + dgramLn;
 //  dgramWriter.write(buf.slice(i, i_next)).catch(console.error);
 //  i = i_next;
 // }
 // if (bufLeftoverLn)
 // {
 //  dgramWriter.write(buf.slice(i, buf.length)).catch(console.error);
 // }
}

async function
WorkerMsgCb(msg: {data: vcap_worker_msg})
{
 const reader = msg.data.readable.getReader();
 let frameCounter = 0;
 while (run)
 {
  const { done, value } = await reader.read();
  if (done) return;
  if (encoder.encodeQueueSize < 3)
  {
   const keyFrame = (frameCounter % framesPerGop) === 0;
   encoder.encode(value as VideoFrame, {keyFrame});
   frameCounter++;
  }
  value.close();
 }
 console.log("[vcap] exited");
}

function
WorkerErrCb(err: any)
{
 console.error(err);
}

async function
Main()
{
 wt = await WebTransportAlloc(certFingerprint);

 // todo request to publish stream
 // {
 //  const buf = new Uint8Array(100);
 //  // chunk.copyTo(buf.subarray(headerLn));
 //  const view = new DataView(buf.buffer);
 //  // set req type
 //  view.setUint32(0, frameId, true);

 //  const thing = await wt.createBidirectionalStream({sendOrder: sendOrderAudio});
 //  const writer = thing.writable.getWriter();
 //  writer.write(buf);
 //  writer.releaseLock();
 //  const reader = thing.readable.getReader();
 //  const res = await reader.read();
 //  res.done;
 //  res.value;
 // }



 // configure encoder
 encoder = new VideoEncoder({
  output: EncoderCb,
  error: console.log,
 });
 const codecs = [
  "vp8", // todo temp codec
  "av01.0.08M.08",
  "vp09.00.40.08",
  "avc1.64002a",
 ];
 const accelerations: Array<HardwareAcceleration> = ["no-preference", "prefer-hardware", "prefer-software"]; //todo temp nopreference

 const configs: Array<VideoEncoderConfig> = [];
 for (const acceleration of accelerations)
 {
  for (const codec of codecs)
  {
   configs.push({
    codec,
    hardwareAcceleration: acceleration,
    width: 1280,
    height: 720,
    bitrate: 2_000_000,
    bitrateMode: "constant",
    framerate: 30,
    latencyMode: "realtime",
   });
  }
 }

 for (const config of configs)
 {
  const support: VideoEncoderSupport = await VideoEncoder.isConfigSupported(config);
  if (support.supported && support.config)
  {
   console.log("VideoEncoder using: ", support.config);
   encoder.configure(support.config);
   break;
  }
 }
}

onmessage = WorkerMsgCb;
onerror = WorkerErrCb;
Main();

export {};
