import { frameHeaderLn, framesPerGop, gopHeaderLn, GopHeaderRead, headerFrame, jitter_buf_el, mat4, metadataFlagIsKey, WebTransportAlloc } from "./util";

export interface recv_worker_msg
{
 canvas: OffscreenCanvas;
};

declare const certFingerprint: string;
let wt: WebTransport;

let decoder: VideoDecoder;

let canvas: OffscreenCanvas;
let ctx: GPUCanvasContext;
let device: GPUDevice;
let pipeline: GPURenderPipeline;
let sampler: GPUSampler;
let uniBuf: GPUBuffer;
let uniVals: Float32Array<ArrayBuffer>;
let matrix: Float32Array<ArrayBuffer>;
let renderPassDescriptor: GPURenderPassDescriptor;

export const jitterBufLn = 256;
export const jitterBufMask = jitterBufLn - 1;
export const jitterBuf: Array<jitter_buf_el> = new Array(jitterBufLn).fill(null).map(() => ({ frame: null, timestamp: 0, frameId: 0, metadata: 0 }));
let jitterBufPlayIdx = 0;
let jitterBufPlayIdxInit = 0;
let jitterBufGotFirstFrame = 0;

function
raceTimeout<T>(prom: Promise<T>): Promise<{skip: boolean} | T>
{
 const timeout: Promise<{skip: boolean}> = new Promise((resolve, _) => setTimeout(() => resolve({ skip: true }), 1000));
 return Promise.race([prom, timeout]);
}

const emptyArr = new Uint8Array();
async function
UnidiCb(stream: ReadableStream)
{
 // receive stream chunks
 const reader = stream.getReader({mode: "byob"});

 // todo signal exit condition
 let done = false;
 while (!done)
 {
  console.log("[recv] Begin recv GOP");
  let strmGopHeader = emptyArr;
  let skip = false;
  {
   const tmpBuf = new Uint8Array(gopHeaderLn);
   const res = await raceTimeout(reader.read(tmpBuf, {min: tmpBuf.length})) as any;
   skip = !!res.skip;
   done = !!res.done;
   strmGopHeader = res.value ?? emptyArr;
  }

  for (let I = 0; !(done || skip) && I < framesPerGop; ++I)
  {
   let strmFrameHeader = emptyArr;
   {
    const tmpBuf = new Uint8Array(frameHeaderLn);
    const res = await raceTimeout(reader.read(tmpBuf, {min: tmpBuf.length})) as any;
    skip = !!res.skip;
    done = !!res.done;
    strmFrameHeader = res.value ?? emptyArr;
   }

   let strmFrame = emptyArr;
   let frameLn = 0;
   if (!(done || skip))
   {
    const strmFrameHeaderView = new DataView(strmFrameHeader!.buffer);
    frameLn = strmFrameHeaderView.getUint32(0, true);
    if (frameLn > 10_000_000)
    {
     console.error("[recv] Error: exceedingly long frameLn:", frameLn);
     done = true;
     break;
    }

    const tmpBuf = new Uint8Array(frameLn);
    const res = await raceTimeout(reader.read(tmpBuf, {min: tmpBuf.length})) as any;
    skip = !!res.skip;
    done = !!res.done;
    strmFrame = res.value ?? emptyArr;
   }

   if (!(skip) && strmFrame.length === frameLn && strmGopHeader.length === gopHeaderLn)
   {
    const strmGopHeaderView = new DataView(strmGopHeader.buffer);
    const strmType = strmGopHeaderView.getUint8(0);
    if (strmType === headerFrame)
    {
     const jitterBufWriteIdx = GopHeaderRead(strmGopHeaderView, jitterBuf, jitterBufMask, I);
     const jitterBufEl = jitterBuf[jitterBufWriteIdx];
     console.log("recv frameid", jitterBufEl.frameId);
     
     jitterBufEl.frame = new EncodedVideoChunk({
      data: new DataView(strmFrame.buffer),
      // ! timestamp is incorrect
      timestamp: jitterBufEl.timestamp,
      // type: jitterBufEl.metadata & metadataFlagIsKey ? "key" : "delta",
      type: I == 0 ? "key" : "delta",
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
       // first frame decoded must be a keyframe
       if (jitterBufGotFirstFrame || (decodeChunk.metadata & metadataFlagIsKey))
       {
        jitterBufGotFirstFrame = 1;
        // console.log("[recv] queuing decode");
        decoder.decode(decodeChunk.frame);
       }
       decodeChunk.frame = null;
       jitterBufPlayIdx++;
       jitterBufPlayIdx %= jitterBufMask;
      }
      else
      {
       console.error("[recv] Error no video chunk at play idx", jitterBufPlayIdx, jitterBufWriteIdx);
      }
     }
    }
   }
  }
 }
 console.log("[recv] Exiting UnidiCb");
 await reader.cancel();
 reader.releaseLock();
 // await stream.cancel();
}

function
DecoderCb(videoFrame: VideoFrame)
{
 const width = videoFrame.displayWidth;
 const height = videoFrame.displayHeight;
 canvas.width = width;
 canvas.height = height;

 const fov = 90 * Math.PI / 180;  // 60 degrees in radians
 const aspect = width / height;
 const zNear  = 0;
 const zFar   = 2000;
 const projectionMatrix = mat4.perspective(fov, aspect, zNear, zFar);

 const cameraPosition = [0, 0, 2];
 const up = [0, 1, 0];
 const target = [0, 0, 0];
 const viewMatrix = mat4.lookAt(cameraPosition, target, up);
 const viewProjectionMatrix = mat4.multiply(projectionMatrix, viewMatrix);

 // Get the current texture from the canvas context and
 // set it as the texture to render to.
 renderPassDescriptor.colorAttachments[0]!.view =
     ctx.getCurrentTexture().createView();
 const encoder = device.createCommandEncoder();
 const pass = encoder.beginRenderPass(renderPassDescriptor);
 pass.setPipeline(pipeline);
 const texture = device.importExternalTexture({source: videoFrame});

 const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
   { binding: 0, resource: sampler },
   { binding: 1, resource: texture },
   { binding: 2, resource: uniBuf },
  ],
 });

 const xSpacing = 0.0;
 const ySpacing = 0.0;
 const zDepth = -3.0;

 const x = -.5;
 const y = 1;

 mat4.translate(viewProjectionMatrix, [x * xSpacing, y * ySpacing, -zDepth * 0.5], matrix);
 // mat4.rotateX(matrix, 0.25 * Math.PI * Math.sign(y), matrix);
 mat4.scale(matrix, [-aspect, -1, 1], matrix);
 mat4.translate(matrix, [-0.5, -0.5, 0], matrix);

 // copy the values from JavaScript to the GPU
 device.queue.writeBuffer(uniBuf, 0, uniVals);

 pass.setBindGroup(0, bindGroup);
 pass.draw(4);
 pass.end();
 const commandBuffer = encoder.finish();
 device.queue.submit([commandBuffer]);
 // console.log("submitted frame");

 videoFrame.close();
}

function
DecoderErrCb(err: Error)
{
 console.error(err);
}

async function
WorkerMsgCb(msg: {data: recv_worker_msg})
{
 canvas = msg.data.canvas;
 ctx = canvas.getContext("webgpu") as GPUCanvasContext;


 // webgpu init


 const adapter = await navigator.gpu?.requestAdapter();
 device = await adapter?.requestDevice()!;
 if (!device)
 {
  console.error("need a browser that supports WebGPU");
  return;
 }
 const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
 ctx.configure({
  device,
  format: presentationFormat,
 });
 const module = device.createShaderModule({
  label: "hardcoded shaders",
  code: `
   struct vs_out
   {
    @builtin(position) position: vec4f,
    @location(0) texcoord: vec2f,
   };

   struct uniforms
   {
    matrix: mat4x4f,
   };

   @group(0) @binding(2) var<uniform> uni: uniforms;

   @vertex fn vs(
    @builtin(vertex_index) vertexIndex : u32
   ) -> vs_out
   {
    let pos = array(
     vec2f(0.0, 0.0),
     vec2f(1.0, 0.0),
     vec2f(0.0, 1.0),
     vec2f(1.0, 1.0),
    );

    var vsOutput: vs_out;
    let xy = pos[vertexIndex];
    vsOutput.position = uni.matrix * vec4f(xy, 0.0, 1.0);
    vsOutput.texcoord = xy;
    return vsOutput;
   }

   @group(0) @binding(0) var ourSampler: sampler;
   @group(0) @binding(1) var ourTexture: texture_external;

   @fragment fn fs(fsInput: vs_out) -> @location(0) vec4f
   {
    return textureSampleBaseClampToEdge(
     ourTexture,
     ourSampler,
     fsInput.texcoord,
    );
   }
  `,
 });
 pipeline = device.createRenderPipeline({
  label: "my pipeline",
  layout: "auto",
  vertex: {module},
  fragment: {
   module,
   targets: [{ format: presentationFormat }],
  },
  primitive: {
   cullMode: "back",
   frontFace: "ccw",
   stripIndexFormat: "uint16",
   topology: "triangle-strip",
   unclippedDepth: false,
  },
 });

 sampler = device.createSampler({
  addressModeU: "repeat",
  addressModeV: "repeat",
  magFilter: "linear",
  minFilter: "linear",
 });
 const uniLn = 16 * 4;
 uniBuf = device.createBuffer({
  label: "my uni",
  size: uniLn,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
 });
 uniVals = new Float32Array(uniLn / 4);
 matrix = uniVals.subarray(0, 16);

 renderPassDescriptor = {
  colorAttachments: [
   {
    view: null!,
    clearValue: [0.3, 0.3, 0.3, 1.0],
    loadOp: "clear",
    storeOp: "store",
   },
  ],
 };

 {
  // clear screen while getting video
  const texView = ctx.getCurrentTexture().createView();
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
   colorAttachments: [
    {
     view: texView,
     clearValue: [0.3, 0.3, 0.3, 1.0],
     loadOp: "clear",
     storeOp: "store",
    },
   ],
  });
  pass.end();
  device.queue.submit([encoder.finish()]);
 }



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

 wt = await WebTransportAlloc(certFingerprint);
 let unidiStrmReader = wt.incomingUnidirectionalStreams.getReader();
 for (;;)
 {
  console.log("[recv] wait");
  const timeout = new Promise((resolve, _) => setTimeout(() => resolve({ skip: 1 }), 5000));
  const res = await Promise.race([unidiStrmReader.read(), timeout]) as any;
  if (res.skip)
  {
   // wtInit = 0;
   console.log('[recv] timeout - skipping');
   await unidiStrmReader.cancel();
   unidiStrmReader.releaseLock();
   wt.close();
   wt = await WebTransportAlloc(certFingerprint);
   unidiStrmReader = wt.incomingUnidirectionalStreams.getReader();
   continue;
  }
  if (res.done)
  {
   break;
  }

  // on ff its a WebTransportReceiveStream
  const stream: ReadableStream = res.value;
  UnidiCb(stream);
 }

 console.log("[recv] loop exit");
}

function
WorkerErrCb(err: any)
{
 console.error(err);
}

async function
Main()
{
 
}

onmessage = WorkerMsgCb;
onerror = WorkerErrCb;

export {};