let wt: WebTransport;
let dgramWriter: WritableStreamDefaultWriter<any>;

function HandleChunk(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void
{
 const buf = new Uint8Array(chunk.byteLength);
 chunk.copyTo(buf);
 const dgramLn = wt.datagrams.maxDatagramSize;
 const bufLeftoverLn = (buf.length % dgramLn);
 const bufRoundLn = buf.length - bufLeftoverLn;
 let i = 0;
 while (i < bufRoundLn)
 {
  const i_next = i + dgramLn;
  dgramWriter.write(buf.slice(i, i_next)).catch(console.error);
  i = i_next;
 }
 if (bufLeftoverLn)
 {
  dgramWriter.write(buf.slice(i, buf.length)).catch(console.error);
 }
}

async function
HandleMsg(Msg: { data: { readable: ReadableStreamDefaultReader<VideoFrame | AudioData> }})
{
 const reader = Msg.data.readable.getReader();
 const hashBytes: Uint8Array = Uint8Array.fromHex("9783d76643e750c11e4c00d16986c2f13924fdc163ca436b2aa875a01c2e47e2");
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
 for (;;)
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
}

onmessage = HandleMsg;

export {};
