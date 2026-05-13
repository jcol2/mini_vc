import { frameHeaderLn, FrameHeaderWrite, sendOrderAudio, sendOrderDefault, sendOrderKeyframe } from "./util";

declare const CertFingerprint: string;
let wt: WebTransport;
let dgramWriter: WritableStreamDefaultWriter<any>;
let run = 1;
let frameId = 0;

async function EncoderCb(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): Promise<void>
{
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
WorkerMsgCb(Msg: { data: { readable: ReadableStreamDefaultReader<VideoFrame | AudioData> }})
{
 const reader = Msg.data.readable.getReader();
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
 wt.closed.finally(() => {run = 0});
 dgramWriter = wt.datagrams.writable.getWriter();

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
 const encoder = new VideoEncoder({
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



 let frameCounter = 0;
 while (run)
 {
  const { done, value } = await reader.read();
  if (done) return;
  if (encoder.encodeQueueSize < 3)
  {
   const keyFrame = frameCounter % 150 == 0;
   encoder.encode(value, {keyFrame});
   frameCounter++;
  }
  value.close();
 }
 console.log("[vcap]", wt.closed);
 console.log("[vcap] exited");
}

function
WorkerErrCb(err: any)
{
 console.error(err);
}

onmessage = WorkerMsgCb;
onerror = WorkerErrCb;

export {};
