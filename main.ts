import WorkerVcapStr from "./worker_vcap.txt";
import WorkerRecvStr from "./worker_recv.txt";
import WorkerNetStr from "./worker_net.txt";
import { MediaStreamTrackProcessor } from "./util";

let vcapBlob: Blob;
let recvBlob: Blob;
let netBlob: Blob;
let vcapWorker: Worker;
let recvWorker: Worker;
let netWorker: Worker;

function
ElQuery(str: string): Element | null
{
 return document.querySelector(str);
}

function
StreamStart(mediaStream: MediaStream, offscreenCanvas: OffscreenCanvas)
{
 const track = mediaStream.getVideoTracks()[0];
 const processor = new MediaStreamTrackProcessor({track});
 const readable = processor.readable;
 const vcapChannel = new MessageChannel();
 const recvChannel = new MessageChannel();

 vcapWorker.postMessage({ readable, port: vcapChannel.port1}, [readable, vcapChannel.port1]);
 recvWorker.postMessage({ canvas: offscreenCanvas, port: recvChannel.port1}, [offscreenCanvas, recvChannel.port1]);
 netWorker.postMessage({ vcapPort: vcapChannel.port2, recvPort: recvChannel.port2}, [vcapChannel.port2, recvChannel.port2]);
}

async function
Main(): Promise<void>
{
 vcapBlob = new Blob([WorkerVcapStr], {type: "text/javascript"});
 recvBlob = new Blob([WorkerRecvStr], {type: "text/javascript"});
 netBlob = new Blob([WorkerNetStr], {type: "text/javascript"});
 vcapWorker = new Worker(window.URL.createObjectURL(vcapBlob), {name: "worker_vcap", type: "module"});
 recvWorker = new Worker(window.URL.createObjectURL(recvBlob), {name: "worker_recv", type: "module"});
 netWorker = new Worker(window.URL.createObjectURL(netBlob), {name: "worker_net", type: "module"});
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