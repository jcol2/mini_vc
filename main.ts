import WorkerVcapStr from "./worker_vcap.txt";
import WorkerRecvStr from "./worker_recv.txt";



// Polyfill from https://github.com/sb2702/webcodecs-utils/blob/main/src/polyfills/media-stream-track-processor.ts



// Firefox doesn't support MediaStreamTrackProcessor so we need to use a polyfill.
// Based on: https://jan-ivar.github.io/polyfills/mediastreamtrackprocessor.js
// and https://github.com/moq-dev/moq/blob/main/js/hang/src/publish/video/polyfill.ts

// AudioWorklet processor code as a string (will be loaded as a Blob URL), avoid worker loading issues in build systems
const AUDIO_WORKLET_CODE = `
class AudioCaptureProcessor extends AudioWorkletProcessor {
  sampleCount = 0;

  process(inputs) {
    if (inputs.length === 0 || inputs[0].length === 0) {
      return true;
    }

    const channels = inputs[0];
    const timestamp = (this.sampleCount / sampleRate) * 1_000_000; // Convert to microseconds

    this.port.postMessage({
      timestamp,
      channels: channels.map(channel => channel.slice()),
    });

    this.sampleCount += channels[0].length;
    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
`;

class MediaStreamTrackProcessorPolyfill {
  readable: ReadableStream<VideoFrame | AudioData>;

  constructor({ track }: { track: MediaStreamTrack }) {
    const settings = track.getSettings();
    if (!settings) {
      throw new Error("track has no settings");
    }

    // Detect track type and use appropriate polyfill
    if (track.kind === 'video') {
      this.readable = this.createVideoStream(track, settings);
    } else if (track.kind === 'audio') {
      this.readable = this.createAudioStream(track, settings);
    } else {
      throw new Error(`Unsupported track kind: ${track.kind}`);
    }
  }

  private createVideoStream(track: MediaStreamTrack, settings: MediaTrackSettings): ReadableStream<VideoFrame> {
    let video: HTMLVideoElement;
    let last: number;
    let lastDuration: number | undefined;

    const frameRate = settings.frameRate ?? 30;

    return new ReadableStream<VideoFrame>({
      async start() {
        video = document.createElement("video") as HTMLVideoElement;
        video.srcObject = new MediaStream([track]);
        await Promise.all([
          video.play(),
          new Promise((r) => {
            video.onloadedmetadata = r;
          }),
        ]);

        last = performance.now();
      },
      async pull(controller) {
        while (true) {
          const now = performance.now();
          if (now - last < 1000 / frameRate) {
            await new Promise((r) => requestAnimationFrame(r));
            continue;
          }

          // Calculate duration based on actual frame timing
          const duration = lastDuration ?? Math.round((now - last) * 1000);
          lastDuration = duration;

          last = now;
          controller.enqueue(new VideoFrame(video, {
            timestamp: last * 1000,
            duration
          }));
          break;
        }
      },
    });
  }

  private createAudioStream(track: MediaStreamTrack, settings: MediaTrackSettings): ReadableStream<AudioData> {
    let audioContext: AudioContext;
    let workletNode: AudioWorkletNode;
    let workletUrl: string;

    return new ReadableStream<AudioData>({
      async start(controller) {
        // Create AudioContext
        audioContext = new AudioContext({
          sampleRate: settings.sampleRate || 48000,
        });

        // Create MediaStreamAudioSourceNode from the track
        const source = new MediaStreamAudioSourceNode(audioContext, {
          mediaStream: new MediaStream([track]),
        });

        // Load the worklet from a Blob URL
        const blob = new Blob([AUDIO_WORKLET_CODE], { type: 'application/javascript' });
        workletUrl = URL.createObjectURL(blob);
        await audioContext.audioWorklet.addModule(workletUrl);

        // Create the worklet node
        workletNode = new AudioWorkletNode(audioContext, 'audio-capture-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: settings.channelCount || 2,
        });

        // Connect the source to the worklet
        source.connect(workletNode);

        // Listen for audio data from the worklet
        workletNode.port.onmessage = (event) => {
          const { timestamp, channels } = event.data;

          // Convert channels to planar format
          const channelData = channels as Float32Array[];
          const numberOfFrames = channelData[0].length;
          const numberOfChannels = channelData.length;

          // Create a single buffer with all channels concatenated
          const totalLength = numberOfFrames * numberOfChannels;
          const buffer = new Float32Array(totalLength);

          for (let i = 0; i < numberOfChannels; i++) {
            buffer.set(channelData[i], i * numberOfFrames);
          }

          try {
            const audioData = new AudioData({
              format: 'f32-planar',
              sampleRate: audioContext.sampleRate,
              numberOfFrames,
              numberOfChannels,
              timestamp,
              data: buffer,
            });

            controller.enqueue(audioData);
          } catch (e) {
            console.error('Failed to create AudioData:', e);
          }
        };
      },
      cancel() {
        // Cleanup
        if (workletNode) {
          workletNode.disconnect();
          workletNode.port.onmessage = null;
        }
        if (audioContext) {
          audioContext.close();
        }
        if (workletUrl) {
          URL.revokeObjectURL(workletUrl);
        }
      }
    });
  }
}

// Auto-polyfill if not available
if (!self.MediaStreamTrackProcessor) {
  self.MediaStreamTrackProcessor = MediaStreamTrackProcessorPolyfill;
}

// Export native if available, polyfill otherwise
const MediaStreamTrackProcessor = self.MediaStreamTrackProcessor || MediaStreamTrackProcessorPolyfill;



// end polyfill




declare global
{
 interface Window
 {
  MediaStreamTrackProcessor: typeof MediaStreamTrackProcessorPolyfill;
 }
};

function
ElQuery(str: string): Element | null
{
 return document.querySelector(str);
}

async function
Main(): Promise<void>
{
 const screenCapBtn = ElQuery("#screen_cap_btn");
 screenCapBtn?.addEventListener("click", async (E) => {
  const capStream = await navigator.mediaDevices.getDisplayMedia();
 });

 const camerCapBtn = ElQuery("#camera_cap_btn");
 camerCapBtn?.addEventListener("click", async (E) => {
  const capStream = await navigator.mediaDevices.getUserMedia(
   {
    video: { width: 1280, height: 720, frameRate: 30 },
    audio: true,
   }
  );
  const track = capStream.getVideoTracks()[0];
  const processor = new MediaStreamTrackProcessor({track});
  const readable = processor.readable;

  const vcapBlob = new Blob([WorkerVcapStr], {type: "text/javascript"});
  const vcapWorker = new Worker(window.URL.createObjectURL(vcapBlob), {name: "worker_vcap"});
  const recvBlob = new Blob([WorkerRecvStr], {type: "text/javascript"});
  const recvWorker = new Worker(window.URL.createObjectURL(recvBlob), {name: "worker_recv"});
  vcapWorker.postMessage({ readable }, [readable]);
  recvWorker.postMessage({}, []);
 });
}

Main();
export {};