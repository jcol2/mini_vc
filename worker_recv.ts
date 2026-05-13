import { frameHeaderLn, FrameHeaderRead, headerFrame, jitter_buf_el, mat4 } from "./util";

declare const CertFingerprint: string;
const metadataFlagIsKey = 0x1;

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
 const headerType = catView.getUint8(0);
 if (headerType === headerFrame)
 {
  const jitterBufWriteIdx = FrameHeaderRead(catView, jitterBuf, jitterBufMask);
  const jitterBufEl = jitterBuf[jitterBufWriteIdx];
  
  jitterBufEl.frame = new EncodedVideoChunk({
   data: new DataView(catBuf.buffer, frameHeaderLn), 
   timestamp: jitterBufEl.timestamp, 
   type: jitterBufEl.metadata & metadataFlagIsKey ? "key" : "delta",
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
    console.error("[recv] Error no video chunk at play idx");
   }
  }
 }
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
WorkerMsgCb(msg: { data: { canvas: OffscreenCanvas }})
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



 // wt init
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