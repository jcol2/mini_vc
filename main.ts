import WorkerVcapStr from "./worker_vcap.txt";
import WorkerRecvStr from "./worker_recv.txt";
import { MediaStreamTrackProcessor } from "./util";

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

 const vcapBlob = new Blob([WorkerVcapStr], {type: "text/javascript"});
 const vcapWorker = new Worker(window.URL.createObjectURL(vcapBlob), {name: "worker_vcap"});
 const recvBlob = new Blob([WorkerRecvStr], {type: "text/javascript"});
 const recvWorker = new Worker(window.URL.createObjectURL(recvBlob), {name: "worker_recv"});
 vcapWorker.postMessage({ readable }, [readable]);
 recvWorker.postMessage({ canvas: offscreenCanvas}, [offscreenCanvas]);
}

async function
Main(): Promise<void>
{
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