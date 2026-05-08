"use strict";
(() => {
  // worker_vcap.txt
  var worker_vcap_default = '"use strict";\n(() => {\n  // worker_vcap.ts\n  var wt;\n  var dgramWriter;\n  var run = 1;\n  var frameId = 0;\n  async function HandleChunk(chunk, metadata) {\n    const isKey = chunk.type == "key" ? 1 : 0;\n    const headerLn = 10;\n    const buf = new Uint8Array(headerLn + chunk.byteLength);\n    chunk.copyTo(buf.subarray(headerLn));\n    const view = new DataView(buf.buffer);\n    view.setUint32(0, frameId, true);\n    view.setUint32(4, 3735928559, true);\n    view.setUint8(8, 0);\n    view.setUint8(9, isKey);\n    const writeStream = await wt.createUnidirectionalStream({ sendOrder: 1 });\n    const writer = writeStream.getWriter();\n    writer.write(buf);\n    writer.releaseLock();\n    writeStream.close();\n    frameId++;\n  }\n  async function HandleMsg(Msg) {\n    const reader = Msg.data.readable.getReader();\n    const hashBytes = Uint8Array.fromHex("df823a1cdf02b7f464865756ad671bf4a9466587f48e9574e7bab1cbb1b9b9e8");\n    wt = new WebTransport(\n      "https://127.0.0.1:4567/",\n      {\n        allowPooling: false,\n        serverCertificateHashes: [\n          {\n            algorithm: "sha-256",\n            value: hashBytes.buffer\n          }\n        ]\n      }\n    );\n    await wt.ready;\n    wt.closed.finally(() => {\n      run = 0;\n    });\n    dgramWriter = wt.datagrams.writable.getWriter();\n    const encoder = new VideoEncoder({\n      output: HandleChunk,\n      error: console.log\n    });\n    encoder.configure({\n      height: 720,\n      width: 1280,\n      bitrate: 2e6,\n      framerate: 60,\n      codec: "vp8",\n      latencyMode: "realtime"\n    });\n    let frameCounter = 0;\n    while (run) {\n      const { done, value } = await reader.read();\n      if (done) return;\n      if (encoder.encodeQueueSize < 3) {\n        const keyFrame = frameCounter % 150 == 0;\n        encoder.encode(value, { keyFrame });\n        frameCounter++;\n      }\n      value.close();\n    }\n    console.log("[vcap]", wt.closed);\n    console.log("[vcap] exited");\n  }\n  onmessage = HandleMsg;\n})();\n';

  // worker_recv.txt
  var worker_recv_default = `"use strict";
(() => {
  // worker_recv.ts
  var wt;
  var decoder;
  var canvas;
  var ctx;
  var jitterBufLn = 256;
  var jitterBufMask = jitterBufLn - 1;
  var jitterBuf = new Array(jitterBufLn).fill(null).map(() => ({ frame: null, timestamp: 0, frameId: 0, metadata: 0 }));
  var jitterBufPlayIdx = 0;
  var jitterBufPlayIdxInit = 0;
  async function HandleData(receiveStream) {
    const reader = receiveStream.getReader();
    const packetBuf = [];
    let catBufLn = 0;
    for (; ; ) {
      console.log("[recv] strm wait");
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      packetBuf.push(value);
      catBufLn += value.length;
    }
    console.log("[recv] my buf ln", catBufLn);
    let catBuf = new Uint8Array(catBufLn);
    let catBufOff = 0;
    for (let I = 0; I < packetBuf.length; ++I) {
      const buf = packetBuf[I];
      catBuf.set(buf, catBufOff);
      catBufOff += buf.length;
    }
    const catView = new DataView(catBuf.buffer);
    const frameId = catView.getUint32(0, true);
    const timestampMs = catView.getUint32(4, true);
    const trackId = catView.getUint8(8);
    const metadata = catView.getUint8(9);
    const jitterBufWriteIdx = frameId & jitterBufMask;
    const jitterBufEl = jitterBuf[jitterBufWriteIdx];
    jitterBufEl.frameId = frameId;
    jitterBufEl.timestamp = timestampMs;
    jitterBufEl.metadata = metadata;
    const frameHeaderLn = 10;
    jitterBufEl.frame = new EncodedVideoChunk({
      data: new DataView(catBuf.buffer, frameHeaderLn),
      timestamp: timestampMs,
      type: metadata ? "key" : "delta"
      // todo specify duration
    });
    if (!jitterBufPlayIdxInit) {
      jitterBufPlayIdxInit = 1;
      jitterBufPlayIdx = jitterBufWriteIdx;
    }
    const delta = jitterBufWriteIdx >= jitterBufPlayIdx ? jitterBufWriteIdx - jitterBufPlayIdx : jitterBufLn - jitterBufPlayIdx + jitterBufWriteIdx;
    if (delta > 6) {
      const decodeChunk = jitterBuf[jitterBufPlayIdx];
      if (decodeChunk.frame) {
        decoder.decode(decodeChunk.frame);
        jitterBufPlayIdx++;
        jitterBufPlayIdx %= jitterBufMask;
      } else {
        console.error("[recv] Error no video chunk at play idx");
      }
    }
  }
  function HandleDecoderOutput(videoFrame) {
    canvas.width = videoFrame.displayWidth;
    canvas.height = videoFrame.displayHeight;
    ctx.drawImage(videoFrame, 0, 0);
    videoFrame.close();
  }
  function HandleDecoderError(err) {
    console.error(err);
  }
  async function HandleMsg(msg) {
    canvas = msg.data.canvas;
    ctx = canvas.getContext("2d");
    const hashBytes = Uint8Array.fromHex("df823a1cdf02b7f464865756ad671bf4a9466587f48e9574e7bab1cbb1b9b9e8");
    wt = new WebTransport(
      "https://127.0.0.1:4567/",
      {
        allowPooling: false,
        serverCertificateHashes: [
          {
            algorithm: "sha-256",
            value: hashBytes.buffer
          }
        ]
      }
    );
    await wt.ready;
    const reader = wt.incomingUnidirectionalStreams.getReader();
    decoder = new VideoDecoder({ output: HandleDecoderOutput, error: HandleDecoderError });
    decoder.configure({
      codec: "vp8",
      optimizeForLatency: true
      // todo chrome doesn't like this:
      // hardwareAcceleration: "prefer-hardware",
      // codedHeight: 720,
      // codedWidth: 1280,
    });
    for (; ; ) {
      console.log("[recv] wait");
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      await HandleData(value);
    }
    console.log("[recv] exited");
  }
  onmessage = HandleMsg;
})();
`;

  // main.ts
  var AUDIO_WORKLET_CODE = `
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
  var MediaStreamTrackProcessorPolyfill = class {
    readable;
    constructor({ track }) {
      const settings = track.getSettings();
      if (!settings) {
        throw new Error("track has no settings");
      }
      if (track.kind === "video") {
        this.readable = this.createVideoStream(track, settings);
      } else if (track.kind === "audio") {
        this.readable = this.createAudioStream(track, settings);
      } else {
        throw new Error(`Unsupported track kind: ${track.kind}`);
      }
    }
    createVideoStream(track, settings) {
      let video;
      let last;
      let lastDuration;
      const frameRate = settings.frameRate ?? 30;
      return new ReadableStream({
        async start() {
          video = document.createElement("video");
          video.srcObject = new MediaStream([track]);
          await Promise.all([
            video.play(),
            new Promise((r) => {
              video.onloadedmetadata = r;
            })
          ]);
          last = performance.now();
        },
        async pull(controller) {
          while (true) {
            const now = performance.now();
            if (now - last < 1e3 / frameRate) {
              await new Promise((r) => requestAnimationFrame(r));
              continue;
            }
            const duration = lastDuration ?? Math.round((now - last) * 1e3);
            lastDuration = duration;
            last = now;
            controller.enqueue(new VideoFrame(video, {
              timestamp: last * 1e3,
              duration
            }));
            break;
          }
        }
      });
    }
    createAudioStream(track, settings) {
      let audioContext;
      let workletNode;
      let workletUrl;
      return new ReadableStream({
        async start(controller) {
          audioContext = new AudioContext({
            sampleRate: settings.sampleRate || 48e3
          });
          const source = new MediaStreamAudioSourceNode(audioContext, {
            mediaStream: new MediaStream([track])
          });
          const blob = new Blob([AUDIO_WORKLET_CODE], { type: "application/javascript" });
          workletUrl = URL.createObjectURL(blob);
          await audioContext.audioWorklet.addModule(workletUrl);
          workletNode = new AudioWorkletNode(audioContext, "audio-capture-processor", {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: settings.channelCount || 2
          });
          source.connect(workletNode);
          workletNode.port.onmessage = (event) => {
            const { timestamp, channels } = event.data;
            const channelData = channels;
            const numberOfFrames = channelData[0].length;
            const numberOfChannels = channelData.length;
            const totalLength = numberOfFrames * numberOfChannels;
            const buffer = new Float32Array(totalLength);
            for (let i = 0; i < numberOfChannels; i++) {
              buffer.set(channelData[i], i * numberOfFrames);
            }
            try {
              const audioData = new AudioData({
                format: "f32-planar",
                sampleRate: audioContext.sampleRate,
                numberOfFrames,
                numberOfChannels,
                timestamp,
                data: buffer
              });
              controller.enqueue(audioData);
            } catch (e) {
              console.error("Failed to create AudioData:", e);
            }
          };
        },
        cancel() {
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
  };
  if (!self.MediaStreamTrackProcessor) {
    self.MediaStreamTrackProcessor = MediaStreamTrackProcessorPolyfill;
  }
  var MediaStreamTrackProcessor = self.MediaStreamTrackProcessor || MediaStreamTrackProcessorPolyfill;
  function ElQuery(str) {
    return document.querySelector(str);
  }
  async function Main() {
    const recvCanvas = ElQuery("#recv_canvas");
    const offscreenCanvas = recvCanvas.transferControlToOffscreen();
    const screenCapBtn = ElQuery("#screen_cap_btn");
    screenCapBtn?.addEventListener("click", async (E) => {
      const capStream = await navigator.mediaDevices.getDisplayMedia();
    });
    const camerCapBtn = ElQuery("#camera_cap_btn");
    camerCapBtn?.addEventListener("click", async (E) => {
      const capStream = await navigator.mediaDevices.getUserMedia(
        {
          video: { width: 1280, height: 720, frameRate: 30 },
          audio: true
        }
      );
      const track = capStream.getVideoTracks()[0];
      const processor = new MediaStreamTrackProcessor({ track });
      const readable = processor.readable;
      const vcapBlob = new Blob([worker_vcap_default], { type: "text/javascript" });
      const vcapWorker = new Worker(window.URL.createObjectURL(vcapBlob), { name: "worker_vcap" });
      const recvBlob = new Blob([worker_recv_default], { type: "text/javascript" });
      const recvWorker = new Worker(window.URL.createObjectURL(recvBlob), { name: "worker_recv" });
      vcapWorker.postMessage({ readable }, [readable]);
      recvWorker.postMessage({ canvas: offscreenCanvas }, [offscreenCanvas]);
    });
  }
  Main();
})();
