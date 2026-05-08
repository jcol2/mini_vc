declare const CertFingerprint: string;
let wt: WebTransport;
let dgramWriter: WritableStreamDefaultWriter<any>;
let run = 1;
let frameId = 0;

async function HandleChunk(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): Promise<void>
{
 const isKey = chunk.type == "key" ? 1 : 0;
 const headerLn = 10;
 const buf = new Uint8Array(headerLn + chunk.byteLength);
 chunk.copyTo(buf.subarray(headerLn));
 const view = new DataView(buf.buffer);
 // set frame id
 view.setUint32(0, frameId, true);
 // set timestamp
 view.setUint32(4, 0xdeadbeef, true);
 // set track id
 view.setUint8(8, 0);
 // set metadata
 view.setUint8(9, isKey);
 // console.log("[vcap] Sending length: ", buf.length);

 const writeStream: WritableStream<any> = await wt.createUnidirectionalStream({sendOrder: 1});
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
HandleMsg(Msg: { data: { readable: ReadableStreamDefaultReader<VideoFrame | AudioData> }})
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

 const encoder = new VideoEncoder({
  output: HandleChunk,
  error: console.log,
 });

 encoder.configure({
  height: 720,
  width: 1280,
  bitrate: 2_000_000,
  framerate: 30,
  codec: "vp8",
  latencyMode: "realtime",
 });
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

onmessage = HandleMsg;

export {};
