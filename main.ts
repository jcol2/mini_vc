import WorkerVcapStr from "./worker_vcap.txt";
import WorkerRecvStr from "./worker_recv.txt";
import { MediaStreamTrackProcessor, WebTransportAlloc } from "./util";
import { recv_worker_msg } from "./worker_recv";
import { vcap_worker_msg } from "./worker_vcap";

declare const certFingerprint: string;
let wt: WebTransport;

let vcapBlob: Blob;
let recvBlob: Blob;
let vcapWorker: Worker;
let recvWorker: Worker;

function
ElQuery(str: string): Element | null
{
 return document.querySelector(str);
}

async function
StreamStart(mediaStream: MediaStream, offscreenCanvas: OffscreenCanvas)
{
 const track = mediaStream.getVideoTracks()[0];
 const processor = new MediaStreamTrackProcessor({track});

 const recvMsg: recv_worker_msg = {
  canvas: offscreenCanvas,
 };
 const vcapMsg: vcap_worker_msg = {
  readable: processor.readable,
 };
 
 vcapWorker.postMessage(vcapMsg, [processor.readable]);
 recvWorker.postMessage(recvMsg, [offscreenCanvas]);
}

async function
Main(): Promise<void>
{
 // wt = await WebTransportAlloc(certFingerprint);

 vcapBlob = new Blob([WorkerVcapStr], {type: "text/javascript"});
 recvBlob = new Blob([WorkerRecvStr], {type: "text/javascript"});
 vcapWorker = new Worker(window.URL.createObjectURL(vcapBlob), {name: "worker_vcap", type: "module"});
 recvWorker = new Worker(window.URL.createObjectURL(recvBlob), {name: "worker_recv", type: "module"});
 const recvCanvas: HTMLCanvasElement = ElQuery("#recv_canvas") as HTMLCanvasElement;
 const offscreenCanvas = recvCanvas.transferControlToOffscreen();

 const screenCapBtn = ElQuery("#screen_cap_btn");
 screenCapBtn?.addEventListener("click", async (E) => {
  const mediaStream = await navigator.mediaDevices.getDisplayMedia();
  StreamStart(mediaStream, offscreenCanvas);
 });

 const camerCapBtn = ElQuery("#camera_cap_btn");
 camerCapBtn?.addEventListener("click", async (E) => {
  const mediaStream = await navigator.mediaDevices.getUserMedia(
   {
    video: { width: 1280, height: 720, frameRate: 30 },
    audio: true,
   }
  );
  StreamStart(mediaStream, offscreenCanvas);
 });
}

Main();
export {};