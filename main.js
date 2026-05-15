"use strict";
(() => {
  // worker_vcap.txt
  var worker_vcap_default = '"use strict";\n(() => {\n  // worker_vcap.ts\n  var encoder;\n  var run = 1;\n  var port;\n  async function EncoderCb(chunk, metadata) {\n    port.postMessage({ chunk });\n  }\n  async function WorkerMsgCb(msg) {\n    port = msg.data.port;\n    const reader = msg.data.readable.getReader();\n    let frameCounter = 0;\n    while (run) {\n      const { done, value } = await reader.read();\n      if (done) return;\n      if (encoder.encodeQueueSize < 3) {\n        const keyFrame = frameCounter % 60 == 0;\n        encoder.encode(value, { keyFrame });\n        frameCounter++;\n      }\n      value.close();\n    }\n    console.log("[vcap] exited");\n  }\n  function WorkerErrCb(err) {\n    console.error(err);\n  }\n  async function Main() {\n    encoder = new VideoEncoder({\n      output: EncoderCb,\n      error: console.log\n    });\n    const codecs = [\n      "vp8",\n      // todo temp codec\n      "av01.0.08M.08",\n      "vp09.00.40.08",\n      "avc1.64002a"\n    ];\n    const accelerations = ["no-preference", "prefer-hardware", "prefer-software"];\n    const configs = [];\n    for (const acceleration of accelerations) {\n      for (const codec of codecs) {\n        configs.push({\n          codec,\n          hardwareAcceleration: acceleration,\n          width: 1280,\n          height: 720,\n          bitrate: 2e6,\n          bitrateMode: "constant",\n          framerate: 30,\n          latencyMode: "realtime"\n        });\n      }\n    }\n    for (const config of configs) {\n      const support = await VideoEncoder.isConfigSupported(config);\n      if (support.supported && support.config) {\n        console.log("VideoEncoder using: ", support.config);\n        encoder.configure(support.config);\n        break;\n      }\n    }\n  }\n  onmessage = WorkerMsgCb;\n  onerror = WorkerErrCb;\n  Main();\n})();\n';

  // worker_recv.txt
  var worker_recv_default = '"use strict";\n(() => {\n  // util.ts\n  var headerFrame = 0;\n  var frameHeaderLn = 11;\n  function FrameHeaderRead(view, jitterBuf2, jitterBufMask2) {\n    const frameId = view.getUint32(1, true);\n    const timestampUs = view.getUint32(5, true);\n    const trackId = view.getUint8(9);\n    const metadata = view.getUint8(10);\n    const jitterBufWriteIdx = frameId & jitterBufMask2;\n    const jitterBufEl = jitterBuf2[jitterBufWriteIdx];\n    jitterBufEl.frameId = frameId;\n    jitterBufEl.timestamp = timestampUs;\n    jitterBufEl.metadata = metadata;\n    return jitterBufWriteIdx;\n  }\n  var AUDIO_WORKLET_CODE = `\nclass AudioCaptureProcessor extends AudioWorkletProcessor {\n  sampleCount = 0;\n\n  process(inputs) {\n    if (inputs.length === 0 || inputs[0].length === 0) {\n      return true;\n    }\n\n    const channels = inputs[0];\n    const timestamp = (this.sampleCount / sampleRate) * 1_000_000; // Convert to microseconds\n\n    this.port.postMessage({\n      timestamp,\n      channels: channels.map(channel => channel.slice()),\n    });\n\n    this.sampleCount += channels[0].length;\n    return true;\n  }\n}\n\nregisterProcessor(\'audio-capture-processor\', AudioCaptureProcessor);\n`;\n  var MediaStreamTrackProcessorPolyfill = class {\n    readable;\n    constructor({ track }) {\n      const settings = track.getSettings();\n      if (!settings) {\n        throw new Error("track has no settings");\n      }\n      if (track.kind === "video") {\n        this.readable = this.createVideoStream(track, settings);\n      } else if (track.kind === "audio") {\n        this.readable = this.createAudioStream(track, settings);\n      } else {\n        throw new Error(`Unsupported track kind: ${track.kind}`);\n      }\n    }\n    createVideoStream(track, settings) {\n      let video;\n      let last;\n      let lastDuration;\n      const frameRate = settings.frameRate ?? 30;\n      return new ReadableStream({\n        async start() {\n          video = document.createElement("video");\n          video.srcObject = new MediaStream([track]);\n          await Promise.all([\n            video.play(),\n            new Promise((r) => {\n              video.onloadedmetadata = r;\n            })\n          ]);\n          last = performance.now();\n        },\n        async pull(controller) {\n          while (true) {\n            const now = performance.now();\n            if (now - last < 1e3 / frameRate) {\n              await new Promise((r) => requestAnimationFrame(r));\n              continue;\n            }\n            const duration = lastDuration ?? Math.round((now - last) * 1e3);\n            lastDuration = duration;\n            last = now;\n            controller.enqueue(new VideoFrame(video, {\n              timestamp: last * 1e3,\n              duration\n            }));\n            break;\n          }\n        }\n      });\n    }\n    createAudioStream(track, settings) {\n      let audioContext;\n      let workletNode;\n      let workletUrl;\n      return new ReadableStream({\n        async start(controller) {\n          audioContext = new AudioContext({\n            sampleRate: settings.sampleRate || 48e3\n          });\n          const source = new MediaStreamAudioSourceNode(audioContext, {\n            mediaStream: new MediaStream([track])\n          });\n          const blob = new Blob([AUDIO_WORKLET_CODE], { type: "application/javascript" });\n          workletUrl = URL.createObjectURL(blob);\n          await audioContext.audioWorklet.addModule(workletUrl);\n          workletNode = new AudioWorkletNode(audioContext, "audio-capture-processor", {\n            numberOfInputs: 1,\n            numberOfOutputs: 0,\n            channelCount: settings.channelCount || 2\n          });\n          source.connect(workletNode);\n          workletNode.port.onmessage = (event) => {\n            const { timestamp, channels } = event.data;\n            const channelData = channels;\n            const numberOfFrames = channelData[0].length;\n            const numberOfChannels = channelData.length;\n            const totalLength = numberOfFrames * numberOfChannels;\n            const buffer = new Float32Array(totalLength);\n            for (let i = 0; i < numberOfChannels; i++) {\n              buffer.set(channelData[i], i * numberOfFrames);\n            }\n            try {\n              const audioData = new AudioData({\n                format: "f32-planar",\n                sampleRate: audioContext.sampleRate,\n                numberOfFrames,\n                numberOfChannels,\n                timestamp,\n                data: buffer\n              });\n              controller.enqueue(audioData);\n            } catch (e) {\n              console.error("Failed to create AudioData:", e);\n            }\n          };\n        },\n        cancel() {\n          if (workletNode) {\n            workletNode.disconnect();\n            workletNode.port.onmessage = null;\n          }\n          if (audioContext) {\n            audioContext.close();\n          }\n          if (workletUrl) {\n            URL.revokeObjectURL(workletUrl);\n          }\n        }\n      });\n    }\n  };\n  if (!self.MediaStreamTrackProcessor) {\n    self.MediaStreamTrackProcessor = MediaStreamTrackProcessorPolyfill;\n  }\n  var MediaStreamTrackProcessor = self.MediaStreamTrackProcessor || MediaStreamTrackProcessorPolyfill;\n  function wrapConstructor(OriginalConstructor, modifier) {\n    return class extends OriginalConstructor {\n      constructor(...args) {\n        super(...args);\n        modifier(this);\n      }\n    };\n  }\n  var ZeroArray = wrapConstructor(Array, (a) => a.fill(0));\n  var EPSILON = 1e-6;\n  function getAPIImpl$5(Ctor) {\n    function create(x = 0, y = 0) {\n      const newDst = new Ctor(2);\n      if (x !== void 0) {\n        newDst[0] = x;\n        if (y !== void 0) {\n          newDst[1] = y;\n        }\n      }\n      return newDst;\n    }\n    const fromValues = create;\n    function set(x, y, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = x;\n      newDst[1] = y;\n      return newDst;\n    }\n    function ceil(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.ceil(v[0]);\n      newDst[1] = Math.ceil(v[1]);\n      return newDst;\n    }\n    function floor(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.floor(v[0]);\n      newDst[1] = Math.floor(v[1]);\n      return newDst;\n    }\n    function round(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.round(v[0]);\n      newDst[1] = Math.round(v[1]);\n      return newDst;\n    }\n    function clamp(v, min2 = 0, max2 = 1, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.min(max2, Math.max(min2, v[0]));\n      newDst[1] = Math.min(max2, Math.max(min2, v[1]));\n      return newDst;\n    }\n    function add(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] + b[0];\n      newDst[1] = a[1] + b[1];\n      return newDst;\n    }\n    function addScaled(a, b, scale2, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] + b[0] * scale2;\n      newDst[1] = a[1] + b[1] * scale2;\n      return newDst;\n    }\n    function angle(a, b) {\n      const ax = a[0];\n      const ay = a[1];\n      const bx = b[0];\n      const by = b[1];\n      const mag1 = Math.sqrt(ax * ax + ay * ay);\n      const mag2 = Math.sqrt(bx * bx + by * by);\n      const mag = mag1 * mag2;\n      const cosine = mag && dot(a, b) / mag;\n      return Math.acos(cosine);\n    }\n    function subtract(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] - b[0];\n      newDst[1] = a[1] - b[1];\n      return newDst;\n    }\n    const sub = subtract;\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1];\n    }\n    function lerp(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] + t * (b[0] - a[0]);\n      newDst[1] = a[1] + t * (b[1] - a[1]);\n      return newDst;\n    }\n    function lerpV(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] + t[0] * (b[0] - a[0]);\n      newDst[1] = a[1] + t[1] * (b[1] - a[1]);\n      return newDst;\n    }\n    function max(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.max(a[0], b[0]);\n      newDst[1] = Math.max(a[1], b[1]);\n      return newDst;\n    }\n    function min(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.min(a[0], b[0]);\n      newDst[1] = Math.min(a[1], b[1]);\n      return newDst;\n    }\n    function mulScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = v[0] * k;\n      newDst[1] = v[1] * k;\n      return newDst;\n    }\n    const scale = mulScalar;\n    function divScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = v[0] / k;\n      newDst[1] = v[1] / k;\n      return newDst;\n    }\n    function inverse(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = 1 / v[0];\n      newDst[1] = 1 / v[1];\n      return newDst;\n    }\n    const invert = inverse;\n    function cross(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const z = a[0] * b[1] - a[1] * b[0];\n      newDst[0] = 0;\n      newDst[1] = 0;\n      newDst[2] = z;\n      return newDst;\n    }\n    function dot(a, b) {\n      return a[0] * b[0] + a[1] * b[1];\n    }\n    function length(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      return Math.sqrt(v0 * v0 + v1 * v1);\n    }\n    const len = length;\n    function lengthSq(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      return v0 * v0 + v1 * v1;\n    }\n    const lenSq = lengthSq;\n    function distance(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      return Math.sqrt(dx * dx + dy * dy);\n    }\n    const dist = distance;\n    function distanceSq(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      return dx * dx + dy * dy;\n    }\n    const distSq = distanceSq;\n    function normalize(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      const v0 = v[0];\n      const v1 = v[1];\n      const len2 = Math.sqrt(v0 * v0 + v1 * v1);\n      if (len2 > 1e-5) {\n        newDst[0] = v0 / len2;\n        newDst[1] = v1 / len2;\n      } else {\n        newDst[0] = 0;\n        newDst[1] = 0;\n      }\n      return newDst;\n    }\n    function negate(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = -v[0];\n      newDst[1] = -v[1];\n      return newDst;\n    }\n    function copy(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = v[0];\n      newDst[1] = v[1];\n      return newDst;\n    }\n    const clone = copy;\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] * b[0];\n      newDst[1] = a[1] * b[1];\n      return newDst;\n    }\n    const mul = multiply;\n    function divide(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] / b[0];\n      newDst[1] = a[1] / b[1];\n      return newDst;\n    }\n    const div = divide;\n    function random(scale2 = 1, dst) {\n      const newDst = dst ?? new Ctor(2);\n      const angle2 = Math.random() * 2 * Math.PI;\n      newDst[0] = Math.cos(angle2) * scale2;\n      newDst[1] = Math.sin(angle2) * scale2;\n      return newDst;\n    }\n    function zero(dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = 0;\n      newDst[1] = 0;\n      return newDst;\n    }\n    function transformMat4(v, m, dst) {\n      const newDst = dst ?? new Ctor(2);\n      const x = v[0];\n      const y = v[1];\n      newDst[0] = x * m[0] + y * m[4] + m[12];\n      newDst[1] = x * m[1] + y * m[5] + m[13];\n      return newDst;\n    }\n    function transformMat3(v, m, dst) {\n      const newDst = dst ?? new Ctor(2);\n      const x = v[0];\n      const y = v[1];\n      newDst[0] = m[0] * x + m[4] * y + m[8];\n      newDst[1] = m[1] * x + m[5] * y + m[9];\n      return newDst;\n    }\n    function rotate(a, b, rad, dst) {\n      const newDst = dst ?? new Ctor(2);\n      const p0 = a[0] - b[0];\n      const p1 = a[1] - b[1];\n      const sinC = Math.sin(rad);\n      const cosC = Math.cos(rad);\n      newDst[0] = p0 * cosC - p1 * sinC + b[0];\n      newDst[1] = p0 * sinC + p1 * cosC + b[1];\n      return newDst;\n    }\n    function setLength(a, len2, dst) {\n      const newDst = dst ?? new Ctor(2);\n      normalize(a, newDst);\n      return mulScalar(newDst, len2, newDst);\n    }\n    function truncate(a, maxLen, dst) {\n      const newDst = dst ?? new Ctor(2);\n      if (length(a) > maxLen) {\n        return setLength(a, maxLen, newDst);\n      }\n      return copy(a, newDst);\n    }\n    function midpoint(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      return lerp(a, b, 0.5, newDst);\n    }\n    return {\n      create,\n      fromValues,\n      set,\n      ceil,\n      floor,\n      round,\n      clamp,\n      add,\n      addScaled,\n      angle,\n      subtract,\n      sub,\n      equalsApproximately,\n      equals,\n      lerp,\n      lerpV,\n      max,\n      min,\n      mulScalar,\n      scale,\n      divScalar,\n      inverse,\n      invert,\n      cross,\n      dot,\n      length,\n      len,\n      lengthSq,\n      lenSq,\n      distance,\n      dist,\n      distanceSq,\n      distSq,\n      normalize,\n      negate,\n      copy,\n      clone,\n      multiply,\n      mul,\n      divide,\n      div,\n      random,\n      zero,\n      transformMat4,\n      transformMat3,\n      rotate,\n      setLength,\n      truncate,\n      midpoint\n    };\n  }\n  var cache$5 = /* @__PURE__ */ new Map();\n  function getAPI$5(Ctor) {\n    let api = cache$5.get(Ctor);\n    if (!api) {\n      api = getAPIImpl$5(Ctor);\n      cache$5.set(Ctor, api);\n    }\n    return api;\n  }\n  function getAPIImpl$4(Ctor) {\n    const vec22 = getAPI$5(Ctor);\n    function create(v0, v1, v2, v3, v4, v5, v6, v7, v8) {\n      const newDst = new Ctor(12);\n      newDst[3] = 0;\n      newDst[7] = 0;\n      newDst[11] = 0;\n      if (v0 !== void 0) {\n        newDst[0] = v0;\n        if (v1 !== void 0) {\n          newDst[1] = v1;\n          if (v2 !== void 0) {\n            newDst[2] = v2;\n            if (v3 !== void 0) {\n              newDst[4] = v3;\n              if (v4 !== void 0) {\n                newDst[5] = v4;\n                if (v5 !== void 0) {\n                  newDst[6] = v5;\n                  if (v6 !== void 0) {\n                    newDst[8] = v6;\n                    if (v7 !== void 0) {\n                      newDst[9] = v7;\n                      if (v8 !== void 0) {\n                        newDst[10] = v8;\n                      }\n                    }\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n      return newDst;\n    }\n    function set(v0, v1, v2, v3, v4, v5, v6, v7, v8, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = v0;\n      newDst[1] = v1;\n      newDst[2] = v2;\n      newDst[3] = 0;\n      newDst[4] = v3;\n      newDst[5] = v4;\n      newDst[6] = v5;\n      newDst[7] = 0;\n      newDst[8] = v6;\n      newDst[9] = v7;\n      newDst[10] = v8;\n      newDst[11] = 0;\n      return newDst;\n    }\n    function fromMat4(m4, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = m4[0];\n      newDst[1] = m4[1];\n      newDst[2] = m4[2];\n      newDst[3] = 0;\n      newDst[4] = m4[4];\n      newDst[5] = m4[5];\n      newDst[6] = m4[6];\n      newDst[7] = 0;\n      newDst[8] = m4[8];\n      newDst[9] = m4[9];\n      newDst[10] = m4[10];\n      newDst[11] = 0;\n      return newDst;\n    }\n    function fromQuat(q, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const x = q[0];\n      const y = q[1];\n      const z = q[2];\n      const w = q[3];\n      const x2 = x + x;\n      const y2 = y + y;\n      const z2 = z + z;\n      const xx = x * x2;\n      const yx = y * x2;\n      const yy = y * y2;\n      const zx = z * x2;\n      const zy = z * y2;\n      const zz = z * z2;\n      const wx = w * x2;\n      const wy = w * y2;\n      const wz = w * z2;\n      newDst[0] = 1 - yy - zz;\n      newDst[1] = yx + wz;\n      newDst[2] = zx - wy;\n      newDst[3] = 0;\n      newDst[4] = yx - wz;\n      newDst[5] = 1 - xx - zz;\n      newDst[6] = zy + wx;\n      newDst[7] = 0;\n      newDst[8] = zx + wy;\n      newDst[9] = zy - wx;\n      newDst[10] = 1 - xx - yy;\n      newDst[11] = 0;\n      return newDst;\n    }\n    function negate(m, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = -m[0];\n      newDst[1] = -m[1];\n      newDst[2] = -m[2];\n      newDst[4] = -m[4];\n      newDst[5] = -m[5];\n      newDst[6] = -m[6];\n      newDst[8] = -m[8];\n      newDst[9] = -m[9];\n      newDst[10] = -m[10];\n      return newDst;\n    }\n    function copy(m, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = m[0];\n      newDst[1] = m[1];\n      newDst[2] = m[2];\n      newDst[4] = m[4];\n      newDst[5] = m[5];\n      newDst[6] = m[6];\n      newDst[8] = m[8];\n      newDst[9] = m[9];\n      newDst[10] = m[10];\n      return newDst;\n    }\n    const clone = copy;\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[4] - b[4]) < EPSILON && Math.abs(a[5] - b[5]) < EPSILON && Math.abs(a[6] - b[6]) < EPSILON && Math.abs(a[8] - b[8]) < EPSILON && Math.abs(a[9] - b[9]) < EPSILON && Math.abs(a[10] - b[10]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[4] === b[4] && a[5] === b[5] && a[6] === b[6] && a[8] === b[8] && a[9] === b[9] && a[10] === b[10];\n    }\n    function identity(dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = 1;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[4] = 0;\n      newDst[5] = 1;\n      newDst[6] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      return newDst;\n    }\n    function transpose(m, dst) {\n      const newDst = dst ?? new Ctor(12);\n      if (newDst === m) {\n        let t;\n        t = m[1];\n        m[1] = m[4];\n        m[4] = t;\n        t = m[2];\n        m[2] = m[8];\n        m[8] = t;\n        t = m[6];\n        m[6] = m[9];\n        m[9] = t;\n        return newDst;\n      }\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      newDst[0] = m00;\n      newDst[1] = m10;\n      newDst[2] = m20;\n      newDst[4] = m01;\n      newDst[5] = m11;\n      newDst[6] = m21;\n      newDst[8] = m02;\n      newDst[9] = m12;\n      newDst[10] = m22;\n      return newDst;\n    }\n    function inverse(m, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const b01 = m22 * m11 - m12 * m21;\n      const b11 = -m22 * m10 + m12 * m20;\n      const b21 = m21 * m10 - m11 * m20;\n      const invDet = 1 / (m00 * b01 + m01 * b11 + m02 * b21);\n      newDst[0] = b01 * invDet;\n      newDst[1] = (-m22 * m01 + m02 * m21) * invDet;\n      newDst[2] = (m12 * m01 - m02 * m11) * invDet;\n      newDst[4] = b11 * invDet;\n      newDst[5] = (m22 * m00 - m02 * m20) * invDet;\n      newDst[6] = (-m12 * m00 + m02 * m10) * invDet;\n      newDst[8] = b21 * invDet;\n      newDst[9] = (-m21 * m00 + m01 * m20) * invDet;\n      newDst[10] = (m11 * m00 - m01 * m10) * invDet;\n      return newDst;\n    }\n    function determinant(m) {\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      return m00 * (m11 * m22 - m21 * m12) - m10 * (m01 * m22 - m21 * m02) + m20 * (m01 * m12 - m11 * m02);\n    }\n    const invert = inverse;\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const a00 = a[0];\n      const a01 = a[1];\n      const a02 = a[2];\n      const a10 = a[4 + 0];\n      const a11 = a[4 + 1];\n      const a12 = a[4 + 2];\n      const a20 = a[8 + 0];\n      const a21 = a[8 + 1];\n      const a22 = a[8 + 2];\n      const b00 = b[0];\n      const b01 = b[1];\n      const b02 = b[2];\n      const b10 = b[4 + 0];\n      const b11 = b[4 + 1];\n      const b12 = b[4 + 2];\n      const b20 = b[8 + 0];\n      const b21 = b[8 + 1];\n      const b22 = b[8 + 2];\n      newDst[0] = a00 * b00 + a10 * b01 + a20 * b02;\n      newDst[1] = a01 * b00 + a11 * b01 + a21 * b02;\n      newDst[2] = a02 * b00 + a12 * b01 + a22 * b02;\n      newDst[4] = a00 * b10 + a10 * b11 + a20 * b12;\n      newDst[5] = a01 * b10 + a11 * b11 + a21 * b12;\n      newDst[6] = a02 * b10 + a12 * b11 + a22 * b12;\n      newDst[8] = a00 * b20 + a10 * b21 + a20 * b22;\n      newDst[9] = a01 * b20 + a11 * b21 + a21 * b22;\n      newDst[10] = a02 * b20 + a12 * b21 + a22 * b22;\n      return newDst;\n    }\n    const mul = multiply;\n    function setTranslation(a, v, dst) {\n      const newDst = dst ?? identity();\n      if (a !== newDst) {\n        newDst[0] = a[0];\n        newDst[1] = a[1];\n        newDst[2] = a[2];\n        newDst[4] = a[4];\n        newDst[5] = a[5];\n        newDst[6] = a[6];\n      }\n      newDst[8] = v[0];\n      newDst[9] = v[1];\n      newDst[10] = 1;\n      return newDst;\n    }\n    function getTranslation(m, dst) {\n      const newDst = dst ?? vec22.create();\n      newDst[0] = m[8];\n      newDst[1] = m[9];\n      return newDst;\n    }\n    function getAxis(m, axis, dst) {\n      const newDst = dst ?? vec22.create();\n      const off = axis * 4;\n      newDst[0] = m[off + 0];\n      newDst[1] = m[off + 1];\n      return newDst;\n    }\n    function setAxis(m, v, axis, dst) {\n      const newDst = dst === m ? m : copy(m, dst);\n      const off = axis * 4;\n      newDst[off + 0] = v[0];\n      newDst[off + 1] = v[1];\n      return newDst;\n    }\n    function getScaling(m, dst) {\n      const newDst = dst ?? vec22.create();\n      const xx = m[0];\n      const xy = m[1];\n      const yx = m[4];\n      const yy = m[5];\n      newDst[0] = Math.sqrt(xx * xx + xy * xy);\n      newDst[1] = Math.sqrt(yx * yx + yy * yy);\n      return newDst;\n    }\n    function translation(v, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = 1;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[4] = 0;\n      newDst[5] = 1;\n      newDst[6] = 0;\n      newDst[8] = v[0];\n      newDst[9] = v[1];\n      newDst[10] = 1;\n      return newDst;\n    }\n    function translate(m, v, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const v0 = v[0];\n      const v1 = v[1];\n      const m00 = m[0];\n      const m01 = m[1];\n      const m02 = m[2];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      if (m !== newDst) {\n        newDst[0] = m00;\n        newDst[1] = m01;\n        newDst[2] = m02;\n        newDst[4] = m10;\n        newDst[5] = m11;\n        newDst[6] = m12;\n      }\n      newDst[8] = m00 * v0 + m10 * v1 + m20;\n      newDst[9] = m01 * v0 + m11 * v1 + m21;\n      newDst[10] = m02 * v0 + m12 * v1 + m22;\n      return newDst;\n    }\n    function rotation(angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c;\n      newDst[1] = s;\n      newDst[2] = 0;\n      newDst[4] = -s;\n      newDst[5] = c;\n      newDst[6] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      return newDst;\n    }\n    function rotate(m, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c * m00 + s * m10;\n      newDst[1] = c * m01 + s * m11;\n      newDst[2] = c * m02 + s * m12;\n      newDst[4] = c * m10 - s * m00;\n      newDst[5] = c * m11 - s * m01;\n      newDst[6] = c * m12 - s * m02;\n      if (m !== newDst) {\n        newDst[8] = m[8];\n        newDst[9] = m[9];\n        newDst[10] = m[10];\n      }\n      return newDst;\n    }\n    function scaling(v, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = v[0];\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[4] = 0;\n      newDst[5] = v[1];\n      newDst[6] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      return newDst;\n    }\n    function scale(m, v, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const v0 = v[0];\n      const v1 = v[1];\n      newDst[0] = v0 * m[0 * 4 + 0];\n      newDst[1] = v0 * m[0 * 4 + 1];\n      newDst[2] = v0 * m[0 * 4 + 2];\n      newDst[4] = v1 * m[1 * 4 + 0];\n      newDst[5] = v1 * m[1 * 4 + 1];\n      newDst[6] = v1 * m[1 * 4 + 2];\n      if (m !== newDst) {\n        newDst[8] = m[8];\n        newDst[9] = m[9];\n        newDst[10] = m[10];\n      }\n      return newDst;\n    }\n    function uniformScaling(s, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = s;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[4] = 0;\n      newDst[5] = s;\n      newDst[6] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      return newDst;\n    }\n    function uniformScale(m, s, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = s * m[0 * 4 + 0];\n      newDst[1] = s * m[0 * 4 + 1];\n      newDst[2] = s * m[0 * 4 + 2];\n      newDst[4] = s * m[1 * 4 + 0];\n      newDst[5] = s * m[1 * 4 + 1];\n      newDst[6] = s * m[1 * 4 + 2];\n      if (m !== newDst) {\n        newDst[8] = m[8];\n        newDst[9] = m[9];\n        newDst[10] = m[10];\n      }\n      return newDst;\n    }\n    return {\n      clone,\n      create,\n      set,\n      fromMat4,\n      fromQuat,\n      negate,\n      copy,\n      equalsApproximately,\n      equals,\n      identity,\n      transpose,\n      inverse,\n      invert,\n      determinant,\n      mul,\n      multiply,\n      setTranslation,\n      getTranslation,\n      getAxis,\n      setAxis,\n      getScaling,\n      translation,\n      translate,\n      rotation,\n      rotate,\n      scaling,\n      scale,\n      uniformScaling,\n      uniformScale\n    };\n  }\n  var cache$4 = /* @__PURE__ */ new Map();\n  function getAPI$4(Ctor) {\n    let api = cache$4.get(Ctor);\n    if (!api) {\n      api = getAPIImpl$4(Ctor);\n      cache$4.set(Ctor, api);\n    }\n    return api;\n  }\n  function getAPIImpl$3(Ctor) {\n    function create(x, y, z) {\n      const newDst = new Ctor(3);\n      if (x !== void 0) {\n        newDst[0] = x;\n        if (y !== void 0) {\n          newDst[1] = y;\n          if (z !== void 0) {\n            newDst[2] = z;\n          }\n        }\n      }\n      return newDst;\n    }\n    const fromValues = create;\n    function set(x, y, z, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = x;\n      newDst[1] = y;\n      newDst[2] = z;\n      return newDst;\n    }\n    function ceil(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.ceil(v[0]);\n      newDst[1] = Math.ceil(v[1]);\n      newDst[2] = Math.ceil(v[2]);\n      return newDst;\n    }\n    function floor(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.floor(v[0]);\n      newDst[1] = Math.floor(v[1]);\n      newDst[2] = Math.floor(v[2]);\n      return newDst;\n    }\n    function round(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.round(v[0]);\n      newDst[1] = Math.round(v[1]);\n      newDst[2] = Math.round(v[2]);\n      return newDst;\n    }\n    function clamp(v, min2 = 0, max2 = 1, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.min(max2, Math.max(min2, v[0]));\n      newDst[1] = Math.min(max2, Math.max(min2, v[1]));\n      newDst[2] = Math.min(max2, Math.max(min2, v[2]));\n      return newDst;\n    }\n    function add(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] + b[0];\n      newDst[1] = a[1] + b[1];\n      newDst[2] = a[2] + b[2];\n      return newDst;\n    }\n    function addScaled(a, b, scale2, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] + b[0] * scale2;\n      newDst[1] = a[1] + b[1] * scale2;\n      newDst[2] = a[2] + b[2] * scale2;\n      return newDst;\n    }\n    function angle(a, b) {\n      const ax = a[0];\n      const ay = a[1];\n      const az = a[2];\n      const bx = b[0];\n      const by = b[1];\n      const bz = b[2];\n      const mag1 = Math.sqrt(ax * ax + ay * ay + az * az);\n      const mag2 = Math.sqrt(bx * bx + by * by + bz * bz);\n      const mag = mag1 * mag2;\n      const cosine = mag && dot(a, b) / mag;\n      return Math.acos(cosine);\n    }\n    function subtract(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] - b[0];\n      newDst[1] = a[1] - b[1];\n      newDst[2] = a[2] - b[2];\n      return newDst;\n    }\n    const sub = subtract;\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];\n    }\n    function lerp(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] + t * (b[0] - a[0]);\n      newDst[1] = a[1] + t * (b[1] - a[1]);\n      newDst[2] = a[2] + t * (b[2] - a[2]);\n      return newDst;\n    }\n    function lerpV(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] + t[0] * (b[0] - a[0]);\n      newDst[1] = a[1] + t[1] * (b[1] - a[1]);\n      newDst[2] = a[2] + t[2] * (b[2] - a[2]);\n      return newDst;\n    }\n    function max(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.max(a[0], b[0]);\n      newDst[1] = Math.max(a[1], b[1]);\n      newDst[2] = Math.max(a[2], b[2]);\n      return newDst;\n    }\n    function min(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.min(a[0], b[0]);\n      newDst[1] = Math.min(a[1], b[1]);\n      newDst[2] = Math.min(a[2], b[2]);\n      return newDst;\n    }\n    function mulScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = v[0] * k;\n      newDst[1] = v[1] * k;\n      newDst[2] = v[2] * k;\n      return newDst;\n    }\n    const scale = mulScalar;\n    function divScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = v[0] / k;\n      newDst[1] = v[1] / k;\n      newDst[2] = v[2] / k;\n      return newDst;\n    }\n    function inverse(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = 1 / v[0];\n      newDst[1] = 1 / v[1];\n      newDst[2] = 1 / v[2];\n      return newDst;\n    }\n    const invert = inverse;\n    function cross(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const t1 = a[2] * b[0] - a[0] * b[2];\n      const t2 = a[0] * b[1] - a[1] * b[0];\n      newDst[0] = a[1] * b[2] - a[2] * b[1];\n      newDst[1] = t1;\n      newDst[2] = t2;\n      return newDst;\n    }\n    function dot(a, b) {\n      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];\n    }\n    function length(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      return Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2);\n    }\n    const len = length;\n    function lengthSq(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      return v0 * v0 + v1 * v1 + v2 * v2;\n    }\n    const lenSq = lengthSq;\n    function distance(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      const dz = a[2] - b[2];\n      return Math.sqrt(dx * dx + dy * dy + dz * dz);\n    }\n    const dist = distance;\n    function distanceSq(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      const dz = a[2] - b[2];\n      return dx * dx + dy * dy + dz * dz;\n    }\n    const distSq = distanceSq;\n    function normalize(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const len2 = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2);\n      if (len2 > 1e-5) {\n        newDst[0] = v0 / len2;\n        newDst[1] = v1 / len2;\n        newDst[2] = v2 / len2;\n      } else {\n        newDst[0] = 0;\n        newDst[1] = 0;\n        newDst[2] = 0;\n      }\n      return newDst;\n    }\n    function negate(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = -v[0];\n      newDst[1] = -v[1];\n      newDst[2] = -v[2];\n      return newDst;\n    }\n    function copy(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = v[0];\n      newDst[1] = v[1];\n      newDst[2] = v[2];\n      return newDst;\n    }\n    const clone = copy;\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] * b[0];\n      newDst[1] = a[1] * b[1];\n      newDst[2] = a[2] * b[2];\n      return newDst;\n    }\n    const mul = multiply;\n    function divide(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] / b[0];\n      newDst[1] = a[1] / b[1];\n      newDst[2] = a[2] / b[2];\n      return newDst;\n    }\n    const div = divide;\n    function random(scale2 = 1, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const angle2 = Math.random() * 2 * Math.PI;\n      const z = Math.random() * 2 - 1;\n      const zScale = Math.sqrt(1 - z * z) * scale2;\n      newDst[0] = Math.cos(angle2) * zScale;\n      newDst[1] = Math.sin(angle2) * zScale;\n      newDst[2] = z * scale2;\n      return newDst;\n    }\n    function zero(dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = 0;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      return newDst;\n    }\n    function transformMat4(v, m, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const x = v[0];\n      const y = v[1];\n      const z = v[2];\n      const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;\n      newDst[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;\n      newDst[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;\n      newDst[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;\n      return newDst;\n    }\n    function transformMat4Upper3x3(v, m, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      newDst[0] = v0 * m[0 * 4 + 0] + v1 * m[1 * 4 + 0] + v2 * m[2 * 4 + 0];\n      newDst[1] = v0 * m[0 * 4 + 1] + v1 * m[1 * 4 + 1] + v2 * m[2 * 4 + 1];\n      newDst[2] = v0 * m[0 * 4 + 2] + v1 * m[1 * 4 + 2] + v2 * m[2 * 4 + 2];\n      return newDst;\n    }\n    function transformMat3(v, m, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const x = v[0];\n      const y = v[1];\n      const z = v[2];\n      newDst[0] = x * m[0] + y * m[4] + z * m[8];\n      newDst[1] = x * m[1] + y * m[5] + z * m[9];\n      newDst[2] = x * m[2] + y * m[6] + z * m[10];\n      return newDst;\n    }\n    function transformQuat(v, q, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const qx = q[0];\n      const qy = q[1];\n      const qz = q[2];\n      const w2 = q[3] * 2;\n      const x = v[0];\n      const y = v[1];\n      const z = v[2];\n      const uvX = qy * z - qz * y;\n      const uvY = qz * x - qx * z;\n      const uvZ = qx * y - qy * x;\n      newDst[0] = x + uvX * w2 + (qy * uvZ - qz * uvY) * 2;\n      newDst[1] = y + uvY * w2 + (qz * uvX - qx * uvZ) * 2;\n      newDst[2] = z + uvZ * w2 + (qx * uvY - qy * uvX) * 2;\n      return newDst;\n    }\n    function getTranslation(m, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = m[12];\n      newDst[1] = m[13];\n      newDst[2] = m[14];\n      return newDst;\n    }\n    function getAxis(m, axis, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const off = axis * 4;\n      newDst[0] = m[off + 0];\n      newDst[1] = m[off + 1];\n      newDst[2] = m[off + 2];\n      return newDst;\n    }\n    function getScaling(m, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const xx = m[0];\n      const xy = m[1];\n      const xz = m[2];\n      const yx = m[4];\n      const yy = m[5];\n      const yz = m[6];\n      const zx = m[8];\n      const zy = m[9];\n      const zz = m[10];\n      newDst[0] = Math.sqrt(xx * xx + xy * xy + xz * xz);\n      newDst[1] = Math.sqrt(yx * yx + yy * yy + yz * yz);\n      newDst[2] = Math.sqrt(zx * zx + zy * zy + zz * zz);\n      return newDst;\n    }\n    function rotateX(a, b, rad, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const p = [];\n      const r = [];\n      p[0] = a[0] - b[0];\n      p[1] = a[1] - b[1];\n      p[2] = a[2] - b[2];\n      r[0] = p[0];\n      r[1] = p[1] * Math.cos(rad) - p[2] * Math.sin(rad);\n      r[2] = p[1] * Math.sin(rad) + p[2] * Math.cos(rad);\n      newDst[0] = r[0] + b[0];\n      newDst[1] = r[1] + b[1];\n      newDst[2] = r[2] + b[2];\n      return newDst;\n    }\n    function rotateY(a, b, rad, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const p = [];\n      const r = [];\n      p[0] = a[0] - b[0];\n      p[1] = a[1] - b[1];\n      p[2] = a[2] - b[2];\n      r[0] = p[2] * Math.sin(rad) + p[0] * Math.cos(rad);\n      r[1] = p[1];\n      r[2] = p[2] * Math.cos(rad) - p[0] * Math.sin(rad);\n      newDst[0] = r[0] + b[0];\n      newDst[1] = r[1] + b[1];\n      newDst[2] = r[2] + b[2];\n      return newDst;\n    }\n    function rotateZ(a, b, rad, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const p = [];\n      const r = [];\n      p[0] = a[0] - b[0];\n      p[1] = a[1] - b[1];\n      p[2] = a[2] - b[2];\n      r[0] = p[0] * Math.cos(rad) - p[1] * Math.sin(rad);\n      r[1] = p[0] * Math.sin(rad) + p[1] * Math.cos(rad);\n      r[2] = p[2];\n      newDst[0] = r[0] + b[0];\n      newDst[1] = r[1] + b[1];\n      newDst[2] = r[2] + b[2];\n      return newDst;\n    }\n    function setLength(a, len2, dst) {\n      const newDst = dst ?? new Ctor(3);\n      normalize(a, newDst);\n      return mulScalar(newDst, len2, newDst);\n    }\n    function truncate(a, maxLen, dst) {\n      const newDst = dst ?? new Ctor(3);\n      if (length(a) > maxLen) {\n        return setLength(a, maxLen, newDst);\n      }\n      return copy(a, newDst);\n    }\n    function midpoint(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      return lerp(a, b, 0.5, newDst);\n    }\n    return {\n      create,\n      fromValues,\n      set,\n      ceil,\n      floor,\n      round,\n      clamp,\n      add,\n      addScaled,\n      angle,\n      subtract,\n      sub,\n      equalsApproximately,\n      equals,\n      lerp,\n      lerpV,\n      max,\n      min,\n      mulScalar,\n      scale,\n      divScalar,\n      inverse,\n      invert,\n      cross,\n      dot,\n      length,\n      len,\n      lengthSq,\n      lenSq,\n      distance,\n      dist,\n      distanceSq,\n      distSq,\n      normalize,\n      negate,\n      copy,\n      clone,\n      multiply,\n      mul,\n      divide,\n      div,\n      random,\n      zero,\n      transformMat4,\n      transformMat4Upper3x3,\n      transformMat3,\n      transformQuat,\n      getTranslation,\n      getAxis,\n      getScaling,\n      rotateX,\n      rotateY,\n      rotateZ,\n      setLength,\n      truncate,\n      midpoint\n    };\n  }\n  var cache$3 = /* @__PURE__ */ new Map();\n  function getAPI$3(Ctor) {\n    let api = cache$3.get(Ctor);\n    if (!api) {\n      api = getAPIImpl$3(Ctor);\n      cache$3.set(Ctor, api);\n    }\n    return api;\n  }\n  function getAPIImpl$2(Ctor) {\n    const vec32 = getAPI$3(Ctor);\n    function create(v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15) {\n      const newDst = new Ctor(16);\n      if (v0 !== void 0) {\n        newDst[0] = v0;\n        if (v1 !== void 0) {\n          newDst[1] = v1;\n          if (v2 !== void 0) {\n            newDst[2] = v2;\n            if (v3 !== void 0) {\n              newDst[3] = v3;\n              if (v4 !== void 0) {\n                newDst[4] = v4;\n                if (v5 !== void 0) {\n                  newDst[5] = v5;\n                  if (v6 !== void 0) {\n                    newDst[6] = v6;\n                    if (v7 !== void 0) {\n                      newDst[7] = v7;\n                      if (v8 !== void 0) {\n                        newDst[8] = v8;\n                        if (v9 !== void 0) {\n                          newDst[9] = v9;\n                          if (v10 !== void 0) {\n                            newDst[10] = v10;\n                            if (v11 !== void 0) {\n                              newDst[11] = v11;\n                              if (v12 !== void 0) {\n                                newDst[12] = v12;\n                                if (v13 !== void 0) {\n                                  newDst[13] = v13;\n                                  if (v14 !== void 0) {\n                                    newDst[14] = v14;\n                                    if (v15 !== void 0) {\n                                      newDst[15] = v15;\n                                    }\n                                  }\n                                }\n                              }\n                            }\n                          }\n                        }\n                      }\n                    }\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n      return newDst;\n    }\n    function set(v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = v0;\n      newDst[1] = v1;\n      newDst[2] = v2;\n      newDst[3] = v3;\n      newDst[4] = v4;\n      newDst[5] = v5;\n      newDst[6] = v6;\n      newDst[7] = v7;\n      newDst[8] = v8;\n      newDst[9] = v9;\n      newDst[10] = v10;\n      newDst[11] = v11;\n      newDst[12] = v12;\n      newDst[13] = v13;\n      newDst[14] = v14;\n      newDst[15] = v15;\n      return newDst;\n    }\n    function fromMat3(m3, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = m3[0];\n      newDst[1] = m3[1];\n      newDst[2] = m3[2];\n      newDst[3] = 0;\n      newDst[4] = m3[4];\n      newDst[5] = m3[5];\n      newDst[6] = m3[6];\n      newDst[7] = 0;\n      newDst[8] = m3[8];\n      newDst[9] = m3[9];\n      newDst[10] = m3[10];\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function fromQuat(q, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const x = q[0];\n      const y = q[1];\n      const z = q[2];\n      const w = q[3];\n      const x2 = x + x;\n      const y2 = y + y;\n      const z2 = z + z;\n      const xx = x * x2;\n      const yx = y * x2;\n      const yy = y * y2;\n      const zx = z * x2;\n      const zy = z * y2;\n      const zz = z * z2;\n      const wx = w * x2;\n      const wy = w * y2;\n      const wz = w * z2;\n      newDst[0] = 1 - yy - zz;\n      newDst[1] = yx + wz;\n      newDst[2] = zx - wy;\n      newDst[3] = 0;\n      newDst[4] = yx - wz;\n      newDst[5] = 1 - xx - zz;\n      newDst[6] = zy + wx;\n      newDst[7] = 0;\n      newDst[8] = zx + wy;\n      newDst[9] = zy - wx;\n      newDst[10] = 1 - xx - yy;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function negate(m, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = -m[0];\n      newDst[1] = -m[1];\n      newDst[2] = -m[2];\n      newDst[3] = -m[3];\n      newDst[4] = -m[4];\n      newDst[5] = -m[5];\n      newDst[6] = -m[6];\n      newDst[7] = -m[7];\n      newDst[8] = -m[8];\n      newDst[9] = -m[9];\n      newDst[10] = -m[10];\n      newDst[11] = -m[11];\n      newDst[12] = -m[12];\n      newDst[13] = -m[13];\n      newDst[14] = -m[14];\n      newDst[15] = -m[15];\n      return newDst;\n    }\n    function copy(m, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = m[0];\n      newDst[1] = m[1];\n      newDst[2] = m[2];\n      newDst[3] = m[3];\n      newDst[4] = m[4];\n      newDst[5] = m[5];\n      newDst[6] = m[6];\n      newDst[7] = m[7];\n      newDst[8] = m[8];\n      newDst[9] = m[9];\n      newDst[10] = m[10];\n      newDst[11] = m[11];\n      newDst[12] = m[12];\n      newDst[13] = m[13];\n      newDst[14] = m[14];\n      newDst[15] = m[15];\n      return newDst;\n    }\n    const clone = copy;\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[3] - b[3]) < EPSILON && Math.abs(a[4] - b[4]) < EPSILON && Math.abs(a[5] - b[5]) < EPSILON && Math.abs(a[6] - b[6]) < EPSILON && Math.abs(a[7] - b[7]) < EPSILON && Math.abs(a[8] - b[8]) < EPSILON && Math.abs(a[9] - b[9]) < EPSILON && Math.abs(a[10] - b[10]) < EPSILON && Math.abs(a[11] - b[11]) < EPSILON && Math.abs(a[12] - b[12]) < EPSILON && Math.abs(a[13] - b[13]) < EPSILON && Math.abs(a[14] - b[14]) < EPSILON && Math.abs(a[15] - b[15]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5] && a[6] === b[6] && a[7] === b[7] && a[8] === b[8] && a[9] === b[9] && a[10] === b[10] && a[11] === b[11] && a[12] === b[12] && a[13] === b[13] && a[14] === b[14] && a[15] === b[15];\n    }\n    function identity(dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = 1;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 1;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function transpose(m, dst) {\n      const newDst = dst ?? new Ctor(16);\n      if (newDst === m) {\n        let t;\n        t = m[1];\n        m[1] = m[4];\n        m[4] = t;\n        t = m[2];\n        m[2] = m[8];\n        m[8] = t;\n        t = m[3];\n        m[3] = m[12];\n        m[12] = t;\n        t = m[6];\n        m[6] = m[9];\n        m[9] = t;\n        t = m[7];\n        m[7] = m[13];\n        m[13] = t;\n        t = m[11];\n        m[11] = m[14];\n        m[14] = t;\n        return newDst;\n      }\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m03 = m[0 * 4 + 3];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m13 = m[1 * 4 + 3];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const m23 = m[2 * 4 + 3];\n      const m30 = m[3 * 4 + 0];\n      const m31 = m[3 * 4 + 1];\n      const m32 = m[3 * 4 + 2];\n      const m33 = m[3 * 4 + 3];\n      newDst[0] = m00;\n      newDst[1] = m10;\n      newDst[2] = m20;\n      newDst[3] = m30;\n      newDst[4] = m01;\n      newDst[5] = m11;\n      newDst[6] = m21;\n      newDst[7] = m31;\n      newDst[8] = m02;\n      newDst[9] = m12;\n      newDst[10] = m22;\n      newDst[11] = m32;\n      newDst[12] = m03;\n      newDst[13] = m13;\n      newDst[14] = m23;\n      newDst[15] = m33;\n      return newDst;\n    }\n    function inverse(m, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m03 = m[0 * 4 + 3];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m13 = m[1 * 4 + 3];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const m23 = m[2 * 4 + 3];\n      const m30 = m[3 * 4 + 0];\n      const m31 = m[3 * 4 + 1];\n      const m32 = m[3 * 4 + 2];\n      const m33 = m[3 * 4 + 3];\n      const tmp0 = m22 * m33;\n      const tmp1 = m32 * m23;\n      const tmp2 = m12 * m33;\n      const tmp3 = m32 * m13;\n      const tmp4 = m12 * m23;\n      const tmp5 = m22 * m13;\n      const tmp6 = m02 * m33;\n      const tmp7 = m32 * m03;\n      const tmp8 = m02 * m23;\n      const tmp9 = m22 * m03;\n      const tmp10 = m02 * m13;\n      const tmp11 = m12 * m03;\n      const tmp12 = m20 * m31;\n      const tmp13 = m30 * m21;\n      const tmp14 = m10 * m31;\n      const tmp15 = m30 * m11;\n      const tmp16 = m10 * m21;\n      const tmp17 = m20 * m11;\n      const tmp18 = m00 * m31;\n      const tmp19 = m30 * m01;\n      const tmp20 = m00 * m21;\n      const tmp21 = m20 * m01;\n      const tmp22 = m00 * m11;\n      const tmp23 = m10 * m01;\n      const t0 = tmp0 * m11 + tmp3 * m21 + tmp4 * m31 - (tmp1 * m11 + tmp2 * m21 + tmp5 * m31);\n      const t1 = tmp1 * m01 + tmp6 * m21 + tmp9 * m31 - (tmp0 * m01 + tmp7 * m21 + tmp8 * m31);\n      const t2 = tmp2 * m01 + tmp7 * m11 + tmp10 * m31 - (tmp3 * m01 + tmp6 * m11 + tmp11 * m31);\n      const t3 = tmp5 * m01 + tmp8 * m11 + tmp11 * m21 - (tmp4 * m01 + tmp9 * m11 + tmp10 * m21);\n      const d = 1 / (m00 * t0 + m10 * t1 + m20 * t2 + m30 * t3);\n      newDst[0] = d * t0;\n      newDst[1] = d * t1;\n      newDst[2] = d * t2;\n      newDst[3] = d * t3;\n      newDst[4] = d * (tmp1 * m10 + tmp2 * m20 + tmp5 * m30 - (tmp0 * m10 + tmp3 * m20 + tmp4 * m30));\n      newDst[5] = d * (tmp0 * m00 + tmp7 * m20 + tmp8 * m30 - (tmp1 * m00 + tmp6 * m20 + tmp9 * m30));\n      newDst[6] = d * (tmp3 * m00 + tmp6 * m10 + tmp11 * m30 - (tmp2 * m00 + tmp7 * m10 + tmp10 * m30));\n      newDst[7] = d * (tmp4 * m00 + tmp9 * m10 + tmp10 * m20 - (tmp5 * m00 + tmp8 * m10 + tmp11 * m20));\n      newDst[8] = d * (tmp12 * m13 + tmp15 * m23 + tmp16 * m33 - (tmp13 * m13 + tmp14 * m23 + tmp17 * m33));\n      newDst[9] = d * (tmp13 * m03 + tmp18 * m23 + tmp21 * m33 - (tmp12 * m03 + tmp19 * m23 + tmp20 * m33));\n      newDst[10] = d * (tmp14 * m03 + tmp19 * m13 + tmp22 * m33 - (tmp15 * m03 + tmp18 * m13 + tmp23 * m33));\n      newDst[11] = d * (tmp17 * m03 + tmp20 * m13 + tmp23 * m23 - (tmp16 * m03 + tmp21 * m13 + tmp22 * m23));\n      newDst[12] = d * (tmp14 * m22 + tmp17 * m32 + tmp13 * m12 - (tmp16 * m32 + tmp12 * m12 + tmp15 * m22));\n      newDst[13] = d * (tmp20 * m32 + tmp12 * m02 + tmp19 * m22 - (tmp18 * m22 + tmp21 * m32 + tmp13 * m02));\n      newDst[14] = d * (tmp18 * m12 + tmp23 * m32 + tmp15 * m02 - (tmp22 * m32 + tmp14 * m02 + tmp19 * m12));\n      newDst[15] = d * (tmp22 * m22 + tmp16 * m02 + tmp21 * m12 - (tmp20 * m12 + tmp23 * m22 + tmp17 * m02));\n      return newDst;\n    }\n    function determinant(m) {\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m03 = m[0 * 4 + 3];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m13 = m[1 * 4 + 3];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const m23 = m[2 * 4 + 3];\n      const m30 = m[3 * 4 + 0];\n      const m31 = m[3 * 4 + 1];\n      const m32 = m[3 * 4 + 2];\n      const m33 = m[3 * 4 + 3];\n      const tmp0 = m22 * m33;\n      const tmp1 = m32 * m23;\n      const tmp2 = m12 * m33;\n      const tmp3 = m32 * m13;\n      const tmp4 = m12 * m23;\n      const tmp5 = m22 * m13;\n      const tmp6 = m02 * m33;\n      const tmp7 = m32 * m03;\n      const tmp8 = m02 * m23;\n      const tmp9 = m22 * m03;\n      const tmp10 = m02 * m13;\n      const tmp11 = m12 * m03;\n      const t0 = tmp0 * m11 + tmp3 * m21 + tmp4 * m31 - (tmp1 * m11 + tmp2 * m21 + tmp5 * m31);\n      const t1 = tmp1 * m01 + tmp6 * m21 + tmp9 * m31 - (tmp0 * m01 + tmp7 * m21 + tmp8 * m31);\n      const t2 = tmp2 * m01 + tmp7 * m11 + tmp10 * m31 - (tmp3 * m01 + tmp6 * m11 + tmp11 * m31);\n      const t3 = tmp5 * m01 + tmp8 * m11 + tmp11 * m21 - (tmp4 * m01 + tmp9 * m11 + tmp10 * m21);\n      return m00 * t0 + m10 * t1 + m20 * t2 + m30 * t3;\n    }\n    const invert = inverse;\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const a00 = a[0];\n      const a01 = a[1];\n      const a02 = a[2];\n      const a03 = a[3];\n      const a10 = a[4 + 0];\n      const a11 = a[4 + 1];\n      const a12 = a[4 + 2];\n      const a13 = a[4 + 3];\n      const a20 = a[8 + 0];\n      const a21 = a[8 + 1];\n      const a22 = a[8 + 2];\n      const a23 = a[8 + 3];\n      const a30 = a[12 + 0];\n      const a31 = a[12 + 1];\n      const a32 = a[12 + 2];\n      const a33 = a[12 + 3];\n      const b00 = b[0];\n      const b01 = b[1];\n      const b02 = b[2];\n      const b03 = b[3];\n      const b10 = b[4 + 0];\n      const b11 = b[4 + 1];\n      const b12 = b[4 + 2];\n      const b13 = b[4 + 3];\n      const b20 = b[8 + 0];\n      const b21 = b[8 + 1];\n      const b22 = b[8 + 2];\n      const b23 = b[8 + 3];\n      const b30 = b[12 + 0];\n      const b31 = b[12 + 1];\n      const b32 = b[12 + 2];\n      const b33 = b[12 + 3];\n      newDst[0] = a00 * b00 + a10 * b01 + a20 * b02 + a30 * b03;\n      newDst[1] = a01 * b00 + a11 * b01 + a21 * b02 + a31 * b03;\n      newDst[2] = a02 * b00 + a12 * b01 + a22 * b02 + a32 * b03;\n      newDst[3] = a03 * b00 + a13 * b01 + a23 * b02 + a33 * b03;\n      newDst[4] = a00 * b10 + a10 * b11 + a20 * b12 + a30 * b13;\n      newDst[5] = a01 * b10 + a11 * b11 + a21 * b12 + a31 * b13;\n      newDst[6] = a02 * b10 + a12 * b11 + a22 * b12 + a32 * b13;\n      newDst[7] = a03 * b10 + a13 * b11 + a23 * b12 + a33 * b13;\n      newDst[8] = a00 * b20 + a10 * b21 + a20 * b22 + a30 * b23;\n      newDst[9] = a01 * b20 + a11 * b21 + a21 * b22 + a31 * b23;\n      newDst[10] = a02 * b20 + a12 * b21 + a22 * b22 + a32 * b23;\n      newDst[11] = a03 * b20 + a13 * b21 + a23 * b22 + a33 * b23;\n      newDst[12] = a00 * b30 + a10 * b31 + a20 * b32 + a30 * b33;\n      newDst[13] = a01 * b30 + a11 * b31 + a21 * b32 + a31 * b33;\n      newDst[14] = a02 * b30 + a12 * b31 + a22 * b32 + a32 * b33;\n      newDst[15] = a03 * b30 + a13 * b31 + a23 * b32 + a33 * b33;\n      return newDst;\n    }\n    const mul = multiply;\n    function setTranslation(a, v, dst) {\n      const newDst = dst ?? identity();\n      if (a !== newDst) {\n        newDst[0] = a[0];\n        newDst[1] = a[1];\n        newDst[2] = a[2];\n        newDst[3] = a[3];\n        newDst[4] = a[4];\n        newDst[5] = a[5];\n        newDst[6] = a[6];\n        newDst[7] = a[7];\n        newDst[8] = a[8];\n        newDst[9] = a[9];\n        newDst[10] = a[10];\n        newDst[11] = a[11];\n      }\n      newDst[12] = v[0];\n      newDst[13] = v[1];\n      newDst[14] = v[2];\n      newDst[15] = 1;\n      return newDst;\n    }\n    function getTranslation(m, dst) {\n      const newDst = dst ?? vec32.create();\n      newDst[0] = m[12];\n      newDst[1] = m[13];\n      newDst[2] = m[14];\n      return newDst;\n    }\n    function getAxis(m, axis, dst) {\n      const newDst = dst ?? vec32.create();\n      const off = axis * 4;\n      newDst[0] = m[off + 0];\n      newDst[1] = m[off + 1];\n      newDst[2] = m[off + 2];\n      return newDst;\n    }\n    function setAxis(m, v, axis, dst) {\n      const newDst = dst === m ? dst : copy(m, dst);\n      const off = axis * 4;\n      newDst[off + 0] = v[0];\n      newDst[off + 1] = v[1];\n      newDst[off + 2] = v[2];\n      return newDst;\n    }\n    function getScaling(m, dst) {\n      const newDst = dst ?? vec32.create();\n      const xx = m[0];\n      const xy = m[1];\n      const xz = m[2];\n      const yx = m[4];\n      const yy = m[5];\n      const yz = m[6];\n      const zx = m[8];\n      const zy = m[9];\n      const zz = m[10];\n      newDst[0] = Math.sqrt(xx * xx + xy * xy + xz * xz);\n      newDst[1] = Math.sqrt(yx * yx + yy * yy + yz * yz);\n      newDst[2] = Math.sqrt(zx * zx + zy * zy + zz * zz);\n      return newDst;\n    }\n    function perspective(fieldOfViewYInRadians, aspect, zNear, zFar, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const f = Math.tan(Math.PI * 0.5 - 0.5 * fieldOfViewYInRadians);\n      newDst[0] = f / aspect;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = f;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[11] = -1;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[15] = 0;\n      if (Number.isFinite(zFar)) {\n        const rangeInv = 1 / (zNear - zFar);\n        newDst[10] = zFar * rangeInv;\n        newDst[14] = zFar * zNear * rangeInv;\n      } else {\n        newDst[10] = -1;\n        newDst[14] = -zNear;\n      }\n      return newDst;\n    }\n    function perspectiveReverseZ(fieldOfViewYInRadians, aspect, zNear, zFar = Infinity, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const f = 1 / Math.tan(fieldOfViewYInRadians * 0.5);\n      newDst[0] = f / aspect;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = f;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[11] = -1;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[15] = 0;\n      if (zFar === Infinity) {\n        newDst[10] = 0;\n        newDst[14] = zNear;\n      } else {\n        const rangeInv = 1 / (zFar - zNear);\n        newDst[10] = zNear * rangeInv;\n        newDst[14] = zFar * zNear * rangeInv;\n      }\n      return newDst;\n    }\n    function ortho(left, right, bottom, top, near, far, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = 2 / (right - left);\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 2 / (top - bottom);\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1 / (near - far);\n      newDst[11] = 0;\n      newDst[12] = (right + left) / (left - right);\n      newDst[13] = (top + bottom) / (bottom - top);\n      newDst[14] = near / (near - far);\n      newDst[15] = 1;\n      return newDst;\n    }\n    function frustum(left, right, bottom, top, near, far, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const dx = right - left;\n      const dy = top - bottom;\n      const dz = near - far;\n      newDst[0] = 2 * near / dx;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 2 * near / dy;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = (left + right) / dx;\n      newDst[9] = (top + bottom) / dy;\n      newDst[10] = far / dz;\n      newDst[11] = -1;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = near * far / dz;\n      newDst[15] = 0;\n      return newDst;\n    }\n    function frustumReverseZ(left, right, bottom, top, near, far = Infinity, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const dx = right - left;\n      const dy = top - bottom;\n      newDst[0] = 2 * near / dx;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 2 * near / dy;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = (left + right) / dx;\n      newDst[9] = (top + bottom) / dy;\n      newDst[11] = -1;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[15] = 0;\n      if (far === Infinity) {\n        newDst[10] = 0;\n        newDst[14] = near;\n      } else {\n        const rangeInv = 1 / (far - near);\n        newDst[10] = near * rangeInv;\n        newDst[14] = far * near * rangeInv;\n      }\n      return newDst;\n    }\n    const xAxis = vec32.create();\n    const yAxis = vec32.create();\n    const zAxis = vec32.create();\n    function aim(position, target, up, dst) {\n      const newDst = dst ?? new Ctor(16);\n      vec32.normalize(vec32.subtract(target, position, zAxis), zAxis);\n      vec32.normalize(vec32.cross(up, zAxis, xAxis), xAxis);\n      vec32.normalize(vec32.cross(zAxis, xAxis, yAxis), yAxis);\n      newDst[0] = xAxis[0];\n      newDst[1] = xAxis[1];\n      newDst[2] = xAxis[2];\n      newDst[3] = 0;\n      newDst[4] = yAxis[0];\n      newDst[5] = yAxis[1];\n      newDst[6] = yAxis[2];\n      newDst[7] = 0;\n      newDst[8] = zAxis[0];\n      newDst[9] = zAxis[1];\n      newDst[10] = zAxis[2];\n      newDst[11] = 0;\n      newDst[12] = position[0];\n      newDst[13] = position[1];\n      newDst[14] = position[2];\n      newDst[15] = 1;\n      return newDst;\n    }\n    function cameraAim(eye, target, up, dst) {\n      const newDst = dst ?? new Ctor(16);\n      vec32.normalize(vec32.subtract(eye, target, zAxis), zAxis);\n      vec32.normalize(vec32.cross(up, zAxis, xAxis), xAxis);\n      vec32.normalize(vec32.cross(zAxis, xAxis, yAxis), yAxis);\n      newDst[0] = xAxis[0];\n      newDst[1] = xAxis[1];\n      newDst[2] = xAxis[2];\n      newDst[3] = 0;\n      newDst[4] = yAxis[0];\n      newDst[5] = yAxis[1];\n      newDst[6] = yAxis[2];\n      newDst[7] = 0;\n      newDst[8] = zAxis[0];\n      newDst[9] = zAxis[1];\n      newDst[10] = zAxis[2];\n      newDst[11] = 0;\n      newDst[12] = eye[0];\n      newDst[13] = eye[1];\n      newDst[14] = eye[2];\n      newDst[15] = 1;\n      return newDst;\n    }\n    function lookAt(eye, target, up, dst) {\n      const newDst = dst ?? new Ctor(16);\n      vec32.normalize(vec32.subtract(eye, target, zAxis), zAxis);\n      vec32.normalize(vec32.cross(up, zAxis, xAxis), xAxis);\n      vec32.normalize(vec32.cross(zAxis, xAxis, yAxis), yAxis);\n      newDst[0] = xAxis[0];\n      newDst[1] = yAxis[0];\n      newDst[2] = zAxis[0];\n      newDst[3] = 0;\n      newDst[4] = xAxis[1];\n      newDst[5] = yAxis[1];\n      newDst[6] = zAxis[1];\n      newDst[7] = 0;\n      newDst[8] = xAxis[2];\n      newDst[9] = yAxis[2];\n      newDst[10] = zAxis[2];\n      newDst[11] = 0;\n      newDst[12] = -(xAxis[0] * eye[0] + xAxis[1] * eye[1] + xAxis[2] * eye[2]);\n      newDst[13] = -(yAxis[0] * eye[0] + yAxis[1] * eye[1] + yAxis[2] * eye[2]);\n      newDst[14] = -(zAxis[0] * eye[0] + zAxis[1] * eye[1] + zAxis[2] * eye[2]);\n      newDst[15] = 1;\n      return newDst;\n    }\n    function translation(v, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = 1;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 1;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      newDst[11] = 0;\n      newDst[12] = v[0];\n      newDst[13] = v[1];\n      newDst[14] = v[2];\n      newDst[15] = 1;\n      return newDst;\n    }\n    function translate(m, v, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const m00 = m[0];\n      const m01 = m[1];\n      const m02 = m[2];\n      const m03 = m[3];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m13 = m[1 * 4 + 3];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const m23 = m[2 * 4 + 3];\n      const m30 = m[3 * 4 + 0];\n      const m31 = m[3 * 4 + 1];\n      const m32 = m[3 * 4 + 2];\n      const m33 = m[3 * 4 + 3];\n      if (m !== newDst) {\n        newDst[0] = m00;\n        newDst[1] = m01;\n        newDst[2] = m02;\n        newDst[3] = m03;\n        newDst[4] = m10;\n        newDst[5] = m11;\n        newDst[6] = m12;\n        newDst[7] = m13;\n        newDst[8] = m20;\n        newDst[9] = m21;\n        newDst[10] = m22;\n        newDst[11] = m23;\n      }\n      newDst[12] = m00 * v0 + m10 * v1 + m20 * v2 + m30;\n      newDst[13] = m01 * v0 + m11 * v1 + m21 * v2 + m31;\n      newDst[14] = m02 * v0 + m12 * v1 + m22 * v2 + m32;\n      newDst[15] = m03 * v0 + m13 * v1 + m23 * v2 + m33;\n      return newDst;\n    }\n    function rotationX(angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = 1;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = c;\n      newDst[6] = s;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = -s;\n      newDst[10] = c;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function rotateX(m, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const m10 = m[4];\n      const m11 = m[5];\n      const m12 = m[6];\n      const m13 = m[7];\n      const m20 = m[8];\n      const m21 = m[9];\n      const m22 = m[10];\n      const m23 = m[11];\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[4] = c * m10 + s * m20;\n      newDst[5] = c * m11 + s * m21;\n      newDst[6] = c * m12 + s * m22;\n      newDst[7] = c * m13 + s * m23;\n      newDst[8] = c * m20 - s * m10;\n      newDst[9] = c * m21 - s * m11;\n      newDst[10] = c * m22 - s * m12;\n      newDst[11] = c * m23 - s * m13;\n      if (m !== newDst) {\n        newDst[0] = m[0];\n        newDst[1] = m[1];\n        newDst[2] = m[2];\n        newDst[3] = m[3];\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    function rotationY(angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c;\n      newDst[1] = 0;\n      newDst[2] = -s;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 1;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = s;\n      newDst[9] = 0;\n      newDst[10] = c;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function rotateY(m, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m03 = m[0 * 4 + 3];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const m23 = m[2 * 4 + 3];\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c * m00 - s * m20;\n      newDst[1] = c * m01 - s * m21;\n      newDst[2] = c * m02 - s * m22;\n      newDst[3] = c * m03 - s * m23;\n      newDst[8] = c * m20 + s * m00;\n      newDst[9] = c * m21 + s * m01;\n      newDst[10] = c * m22 + s * m02;\n      newDst[11] = c * m23 + s * m03;\n      if (m !== newDst) {\n        newDst[4] = m[4];\n        newDst[5] = m[5];\n        newDst[6] = m[6];\n        newDst[7] = m[7];\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    function rotationZ(angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c;\n      newDst[1] = s;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = -s;\n      newDst[5] = c;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function rotateZ(m, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m03 = m[0 * 4 + 3];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m13 = m[1 * 4 + 3];\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c * m00 + s * m10;\n      newDst[1] = c * m01 + s * m11;\n      newDst[2] = c * m02 + s * m12;\n      newDst[3] = c * m03 + s * m13;\n      newDst[4] = c * m10 - s * m00;\n      newDst[5] = c * m11 - s * m01;\n      newDst[6] = c * m12 - s * m02;\n      newDst[7] = c * m13 - s * m03;\n      if (m !== newDst) {\n        newDst[8] = m[8];\n        newDst[9] = m[9];\n        newDst[10] = m[10];\n        newDst[11] = m[11];\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    function axisRotation(axis, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      let x = axis[0];\n      let y = axis[1];\n      let z = axis[2];\n      const n = Math.sqrt(x * x + y * y + z * z);\n      x /= n;\n      y /= n;\n      z /= n;\n      const xx = x * x;\n      const yy = y * y;\n      const zz = z * z;\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      const oneMinusCosine = 1 - c;\n      newDst[0] = xx + (1 - xx) * c;\n      newDst[1] = x * y * oneMinusCosine + z * s;\n      newDst[2] = x * z * oneMinusCosine - y * s;\n      newDst[3] = 0;\n      newDst[4] = x * y * oneMinusCosine - z * s;\n      newDst[5] = yy + (1 - yy) * c;\n      newDst[6] = y * z * oneMinusCosine + x * s;\n      newDst[7] = 0;\n      newDst[8] = x * z * oneMinusCosine + y * s;\n      newDst[9] = y * z * oneMinusCosine - x * s;\n      newDst[10] = zz + (1 - zz) * c;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    const rotation = axisRotation;\n    function axisRotate(m, axis, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      let x = axis[0];\n      let y = axis[1];\n      let z = axis[2];\n      const n = Math.sqrt(x * x + y * y + z * z);\n      x /= n;\n      y /= n;\n      z /= n;\n      const xx = x * x;\n      const yy = y * y;\n      const zz = z * z;\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      const oneMinusCosine = 1 - c;\n      const r00 = xx + (1 - xx) * c;\n      const r01 = x * y * oneMinusCosine + z * s;\n      const r02 = x * z * oneMinusCosine - y * s;\n      const r10 = x * y * oneMinusCosine - z * s;\n      const r11 = yy + (1 - yy) * c;\n      const r12 = y * z * oneMinusCosine + x * s;\n      const r20 = x * z * oneMinusCosine + y * s;\n      const r21 = y * z * oneMinusCosine - x * s;\n      const r22 = zz + (1 - zz) * c;\n      const m00 = m[0];\n      const m01 = m[1];\n      const m02 = m[2];\n      const m03 = m[3];\n      const m10 = m[4];\n      const m11 = m[5];\n      const m12 = m[6];\n      const m13 = m[7];\n      const m20 = m[8];\n      const m21 = m[9];\n      const m22 = m[10];\n      const m23 = m[11];\n      newDst[0] = r00 * m00 + r01 * m10 + r02 * m20;\n      newDst[1] = r00 * m01 + r01 * m11 + r02 * m21;\n      newDst[2] = r00 * m02 + r01 * m12 + r02 * m22;\n      newDst[3] = r00 * m03 + r01 * m13 + r02 * m23;\n      newDst[4] = r10 * m00 + r11 * m10 + r12 * m20;\n      newDst[5] = r10 * m01 + r11 * m11 + r12 * m21;\n      newDst[6] = r10 * m02 + r11 * m12 + r12 * m22;\n      newDst[7] = r10 * m03 + r11 * m13 + r12 * m23;\n      newDst[8] = r20 * m00 + r21 * m10 + r22 * m20;\n      newDst[9] = r20 * m01 + r21 * m11 + r22 * m21;\n      newDst[10] = r20 * m02 + r21 * m12 + r22 * m22;\n      newDst[11] = r20 * m03 + r21 * m13 + r22 * m23;\n      if (m !== newDst) {\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    const rotate = axisRotate;\n    function scaling(v, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = v[0];\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = v[1];\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = v[2];\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function scale(m, v, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      newDst[0] = v0 * m[0 * 4 + 0];\n      newDst[1] = v0 * m[0 * 4 + 1];\n      newDst[2] = v0 * m[0 * 4 + 2];\n      newDst[3] = v0 * m[0 * 4 + 3];\n      newDst[4] = v1 * m[1 * 4 + 0];\n      newDst[5] = v1 * m[1 * 4 + 1];\n      newDst[6] = v1 * m[1 * 4 + 2];\n      newDst[7] = v1 * m[1 * 4 + 3];\n      newDst[8] = v2 * m[2 * 4 + 0];\n      newDst[9] = v2 * m[2 * 4 + 1];\n      newDst[10] = v2 * m[2 * 4 + 2];\n      newDst[11] = v2 * m[2 * 4 + 3];\n      if (m !== newDst) {\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    function uniformScaling(s, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = s;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = s;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = s;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function uniformScale(m, s, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = s * m[0 * 4 + 0];\n      newDst[1] = s * m[0 * 4 + 1];\n      newDst[2] = s * m[0 * 4 + 2];\n      newDst[3] = s * m[0 * 4 + 3];\n      newDst[4] = s * m[1 * 4 + 0];\n      newDst[5] = s * m[1 * 4 + 1];\n      newDst[6] = s * m[1 * 4 + 2];\n      newDst[7] = s * m[1 * 4 + 3];\n      newDst[8] = s * m[2 * 4 + 0];\n      newDst[9] = s * m[2 * 4 + 1];\n      newDst[10] = s * m[2 * 4 + 2];\n      newDst[11] = s * m[2 * 4 + 3];\n      if (m !== newDst) {\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    return {\n      create,\n      set,\n      fromMat3,\n      fromQuat,\n      negate,\n      copy,\n      clone,\n      equalsApproximately,\n      equals,\n      identity,\n      transpose,\n      inverse,\n      determinant,\n      invert,\n      multiply,\n      mul,\n      setTranslation,\n      getTranslation,\n      getAxis,\n      setAxis,\n      getScaling,\n      perspective,\n      perspectiveReverseZ,\n      ortho,\n      frustum,\n      frustumReverseZ,\n      aim,\n      cameraAim,\n      lookAt,\n      translation,\n      translate,\n      rotationX,\n      rotateX,\n      rotationY,\n      rotateY,\n      rotationZ,\n      rotateZ,\n      axisRotation,\n      rotation,\n      axisRotate,\n      rotate,\n      scaling,\n      scale,\n      uniformScaling,\n      uniformScale\n    };\n  }\n  var cache$2 = /* @__PURE__ */ new Map();\n  function getAPI$2(Ctor) {\n    let api = cache$2.get(Ctor);\n    if (!api) {\n      api = getAPIImpl$2(Ctor);\n      cache$2.set(Ctor, api);\n    }\n    return api;\n  }\n  function getAPIImpl$1(Ctor) {\n    const vec32 = getAPI$3(Ctor);\n    function create(x, y, z, w) {\n      const newDst = new Ctor(4);\n      if (x !== void 0) {\n        newDst[0] = x;\n        if (y !== void 0) {\n          newDst[1] = y;\n          if (z !== void 0) {\n            newDst[2] = z;\n            if (w !== void 0) {\n              newDst[3] = w;\n            }\n          }\n        }\n      }\n      return newDst;\n    }\n    const fromValues = create;\n    function set(x, y, z, w, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = x;\n      newDst[1] = y;\n      newDst[2] = z;\n      newDst[3] = w;\n      return newDst;\n    }\n    function fromAxisAngle(axis, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const halfAngle = angleInRadians * 0.5;\n      const s = Math.sin(halfAngle);\n      newDst[0] = s * axis[0];\n      newDst[1] = s * axis[1];\n      newDst[2] = s * axis[2];\n      newDst[3] = Math.cos(halfAngle);\n      return newDst;\n    }\n    function toAxisAngle(q, dst) {\n      const newDst = dst ?? vec32.create(3);\n      const angle2 = Math.acos(q[3]) * 2;\n      const s = Math.sin(angle2 * 0.5);\n      if (s > EPSILON) {\n        newDst[0] = q[0] / s;\n        newDst[1] = q[1] / s;\n        newDst[2] = q[2] / s;\n      } else {\n        newDst[0] = 1;\n        newDst[1] = 0;\n        newDst[2] = 0;\n      }\n      return { angle: angle2, axis: newDst };\n    }\n    function angle(a, b) {\n      const d = dot(a, b);\n      return Math.acos(2 * d * d - 1);\n    }\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const ax = a[0];\n      const ay = a[1];\n      const az = a[2];\n      const aw = a[3];\n      const bx = b[0];\n      const by = b[1];\n      const bz = b[2];\n      const bw = b[3];\n      newDst[0] = ax * bw + aw * bx + ay * bz - az * by;\n      newDst[1] = ay * bw + aw * by + az * bx - ax * bz;\n      newDst[2] = az * bw + aw * bz + ax * by - ay * bx;\n      newDst[3] = aw * bw - ax * bx - ay * by - az * bz;\n      return newDst;\n    }\n    const mul = multiply;\n    function rotateX(q, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const halfAngle = angleInRadians * 0.5;\n      const qx = q[0];\n      const qy = q[1];\n      const qz = q[2];\n      const qw = q[3];\n      const bx = Math.sin(halfAngle);\n      const bw = Math.cos(halfAngle);\n      newDst[0] = qx * bw + qw * bx;\n      newDst[1] = qy * bw + qz * bx;\n      newDst[2] = qz * bw - qy * bx;\n      newDst[3] = qw * bw - qx * bx;\n      return newDst;\n    }\n    function rotateY(q, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const halfAngle = angleInRadians * 0.5;\n      const qx = q[0];\n      const qy = q[1];\n      const qz = q[2];\n      const qw = q[3];\n      const by = Math.sin(halfAngle);\n      const bw = Math.cos(halfAngle);\n      newDst[0] = qx * bw - qz * by;\n      newDst[1] = qy * bw + qw * by;\n      newDst[2] = qz * bw + qx * by;\n      newDst[3] = qw * bw - qy * by;\n      return newDst;\n    }\n    function rotateZ(q, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const halfAngle = angleInRadians * 0.5;\n      const qx = q[0];\n      const qy = q[1];\n      const qz = q[2];\n      const qw = q[3];\n      const bz = Math.sin(halfAngle);\n      const bw = Math.cos(halfAngle);\n      newDst[0] = qx * bw + qy * bz;\n      newDst[1] = qy * bw - qx * bz;\n      newDst[2] = qz * bw + qw * bz;\n      newDst[3] = qw * bw - qz * bz;\n      return newDst;\n    }\n    function slerp(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const ax = a[0];\n      const ay = a[1];\n      const az = a[2];\n      const aw = a[3];\n      let bx = b[0];\n      let by = b[1];\n      let bz = b[2];\n      let bw = b[3];\n      let cosOmega = ax * bx + ay * by + az * bz + aw * bw;\n      if (cosOmega < 0) {\n        cosOmega = -cosOmega;\n        bx = -bx;\n        by = -by;\n        bz = -bz;\n        bw = -bw;\n      }\n      let scale0;\n      let scale1;\n      if (1 - cosOmega > EPSILON) {\n        const omega = Math.acos(cosOmega);\n        const sinOmega = Math.sin(omega);\n        scale0 = Math.sin((1 - t) * omega) / sinOmega;\n        scale1 = Math.sin(t * omega) / sinOmega;\n      } else {\n        scale0 = 1 - t;\n        scale1 = t;\n      }\n      newDst[0] = scale0 * ax + scale1 * bx;\n      newDst[1] = scale0 * ay + scale1 * by;\n      newDst[2] = scale0 * az + scale1 * bz;\n      newDst[3] = scale0 * aw + scale1 * bw;\n      return newDst;\n    }\n    function inverse(q, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const a0 = q[0];\n      const a1 = q[1];\n      const a2 = q[2];\n      const a3 = q[3];\n      const dot2 = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;\n      const invDot = dot2 ? 1 / dot2 : 0;\n      newDst[0] = -a0 * invDot;\n      newDst[1] = -a1 * invDot;\n      newDst[2] = -a2 * invDot;\n      newDst[3] = a3 * invDot;\n      return newDst;\n    }\n    function conjugate(q, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = -q[0];\n      newDst[1] = -q[1];\n      newDst[2] = -q[2];\n      newDst[3] = q[3];\n      return newDst;\n    }\n    function fromMat(m, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const trace = m[0] + m[5] + m[10];\n      if (trace > 0) {\n        const root = Math.sqrt(trace + 1);\n        newDst[3] = 0.5 * root;\n        const invRoot = 0.5 / root;\n        newDst[0] = (m[6] - m[9]) * invRoot;\n        newDst[1] = (m[8] - m[2]) * invRoot;\n        newDst[2] = (m[1] - m[4]) * invRoot;\n      } else {\n        let i = 0;\n        if (m[5] > m[0]) {\n          i = 1;\n        }\n        if (m[10] > m[i * 4 + i]) {\n          i = 2;\n        }\n        const j = (i + 1) % 3;\n        const k = (i + 2) % 3;\n        const root = Math.sqrt(m[i * 4 + i] - m[j * 4 + j] - m[k * 4 + k] + 1);\n        newDst[i] = 0.5 * root;\n        const invRoot = 0.5 / root;\n        newDst[3] = (m[j * 4 + k] - m[k * 4 + j]) * invRoot;\n        newDst[j] = (m[j * 4 + i] + m[i * 4 + j]) * invRoot;\n        newDst[k] = (m[k * 4 + i] + m[i * 4 + k]) * invRoot;\n      }\n      return newDst;\n    }\n    function fromEuler(xAngleInRadians, yAngleInRadians, zAngleInRadians, order, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const xHalfAngle = xAngleInRadians * 0.5;\n      const yHalfAngle = yAngleInRadians * 0.5;\n      const zHalfAngle = zAngleInRadians * 0.5;\n      const sx = Math.sin(xHalfAngle);\n      const cx = Math.cos(xHalfAngle);\n      const sy = Math.sin(yHalfAngle);\n      const cy = Math.cos(yHalfAngle);\n      const sz = Math.sin(zHalfAngle);\n      const cz = Math.cos(zHalfAngle);\n      switch (order) {\n        case "xyz":\n          newDst[0] = sx * cy * cz + cx * sy * sz;\n          newDst[1] = cx * sy * cz - sx * cy * sz;\n          newDst[2] = cx * cy * sz + sx * sy * cz;\n          newDst[3] = cx * cy * cz - sx * sy * sz;\n          break;\n        case "xzy":\n          newDst[0] = sx * cy * cz - cx * sy * sz;\n          newDst[1] = cx * sy * cz - sx * cy * sz;\n          newDst[2] = cx * cy * sz + sx * sy * cz;\n          newDst[3] = cx * cy * cz + sx * sy * sz;\n          break;\n        case "yxz":\n          newDst[0] = sx * cy * cz + cx * sy * sz;\n          newDst[1] = cx * sy * cz - sx * cy * sz;\n          newDst[2] = cx * cy * sz - sx * sy * cz;\n          newDst[3] = cx * cy * cz + sx * sy * sz;\n          break;\n        case "yzx":\n          newDst[0] = sx * cy * cz + cx * sy * sz;\n          newDst[1] = cx * sy * cz + sx * cy * sz;\n          newDst[2] = cx * cy * sz - sx * sy * cz;\n          newDst[3] = cx * cy * cz - sx * sy * sz;\n          break;\n        case "zxy":\n          newDst[0] = sx * cy * cz - cx * sy * sz;\n          newDst[1] = cx * sy * cz + sx * cy * sz;\n          newDst[2] = cx * cy * sz + sx * sy * cz;\n          newDst[3] = cx * cy * cz - sx * sy * sz;\n          break;\n        case "zyx":\n          newDst[0] = sx * cy * cz - cx * sy * sz;\n          newDst[1] = cx * sy * cz + sx * cy * sz;\n          newDst[2] = cx * cy * sz - sx * sy * cz;\n          newDst[3] = cx * cy * cz + sx * sy * sz;\n          break;\n        default:\n          throw new Error(`Unknown rotation order: ${order}`);\n      }\n      return newDst;\n    }\n    function copy(q, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = q[0];\n      newDst[1] = q[1];\n      newDst[2] = q[2];\n      newDst[3] = q[3];\n      return newDst;\n    }\n    const clone = copy;\n    function add(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + b[0];\n      newDst[1] = a[1] + b[1];\n      newDst[2] = a[2] + b[2];\n      newDst[3] = a[3] + b[3];\n      return newDst;\n    }\n    function subtract(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] - b[0];\n      newDst[1] = a[1] - b[1];\n      newDst[2] = a[2] - b[2];\n      newDst[3] = a[3] - b[3];\n      return newDst;\n    }\n    const sub = subtract;\n    function mulScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = v[0] * k;\n      newDst[1] = v[1] * k;\n      newDst[2] = v[2] * k;\n      newDst[3] = v[3] * k;\n      return newDst;\n    }\n    const scale = mulScalar;\n    function divScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = v[0] / k;\n      newDst[1] = v[1] / k;\n      newDst[2] = v[2] / k;\n      newDst[3] = v[3] / k;\n      return newDst;\n    }\n    function dot(a, b) {\n      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];\n    }\n    function lerp(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + t * (b[0] - a[0]);\n      newDst[1] = a[1] + t * (b[1] - a[1]);\n      newDst[2] = a[2] + t * (b[2] - a[2]);\n      newDst[3] = a[3] + t * (b[3] - a[3]);\n      return newDst;\n    }\n    function length(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      return Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);\n    }\n    const len = length;\n    function lengthSq(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      return v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3;\n    }\n    const lenSq = lengthSq;\n    function normalize(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      const len2 = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);\n      if (len2 > 1e-5) {\n        newDst[0] = v0 / len2;\n        newDst[1] = v1 / len2;\n        newDst[2] = v2 / len2;\n        newDst[3] = v3 / len2;\n      } else {\n        newDst[0] = 0;\n        newDst[1] = 0;\n        newDst[2] = 0;\n        newDst[3] = 0;\n      }\n      return newDst;\n    }\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[3] - b[3]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];\n    }\n    function identity(dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = 0;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 1;\n      return newDst;\n    }\n    const tempVec3 = vec32.create();\n    const xUnitVec3 = vec32.create();\n    const yUnitVec3 = vec32.create();\n    function rotationTo(aUnit, bUnit, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const dot2 = vec32.dot(aUnit, bUnit);\n      if (dot2 < -0.999999) {\n        vec32.cross(xUnitVec3, aUnit, tempVec3);\n        if (vec32.len(tempVec3) < 1e-6) {\n          vec32.cross(yUnitVec3, aUnit, tempVec3);\n        }\n        vec32.normalize(tempVec3, tempVec3);\n        fromAxisAngle(tempVec3, Math.PI, newDst);\n        return newDst;\n      } else if (dot2 > 0.999999) {\n        newDst[0] = 0;\n        newDst[1] = 0;\n        newDst[2] = 0;\n        newDst[3] = 1;\n        return newDst;\n      } else {\n        vec32.cross(aUnit, bUnit, tempVec3);\n        newDst[0] = tempVec3[0];\n        newDst[1] = tempVec3[1];\n        newDst[2] = tempVec3[2];\n        newDst[3] = 1 + dot2;\n        return normalize(newDst, newDst);\n      }\n    }\n    const tempQuat1 = new Ctor(4);\n    const tempQuat2 = new Ctor(4);\n    function sqlerp(a, b, c, d, t, dst) {\n      const newDst = dst ?? new Ctor(4);\n      slerp(a, d, t, tempQuat1);\n      slerp(b, c, t, tempQuat2);\n      slerp(tempQuat1, tempQuat2, 2 * t * (1 - t), newDst);\n      return newDst;\n    }\n    return {\n      create,\n      fromValues,\n      set,\n      fromAxisAngle,\n      toAxisAngle,\n      angle,\n      multiply,\n      mul,\n      rotateX,\n      rotateY,\n      rotateZ,\n      slerp,\n      inverse,\n      conjugate,\n      fromMat,\n      fromEuler,\n      copy,\n      clone,\n      add,\n      subtract,\n      sub,\n      mulScalar,\n      scale,\n      divScalar,\n      dot,\n      lerp,\n      length,\n      len,\n      lengthSq,\n      lenSq,\n      normalize,\n      equalsApproximately,\n      equals,\n      identity,\n      rotationTo,\n      sqlerp\n    };\n  }\n  var cache$1 = /* @__PURE__ */ new Map();\n  function getAPI$1(Ctor) {\n    let api = cache$1.get(Ctor);\n    if (!api) {\n      api = getAPIImpl$1(Ctor);\n      cache$1.set(Ctor, api);\n    }\n    return api;\n  }\n  function getAPIImpl(Ctor) {\n    function create(x, y, z, w) {\n      const newDst = new Ctor(4);\n      if (x !== void 0) {\n        newDst[0] = x;\n        if (y !== void 0) {\n          newDst[1] = y;\n          if (z !== void 0) {\n            newDst[2] = z;\n            if (w !== void 0) {\n              newDst[3] = w;\n            }\n          }\n        }\n      }\n      return newDst;\n    }\n    const fromValues = create;\n    function set(x, y, z, w, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = x;\n      newDst[1] = y;\n      newDst[2] = z;\n      newDst[3] = w;\n      return newDst;\n    }\n    function ceil(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.ceil(v[0]);\n      newDst[1] = Math.ceil(v[1]);\n      newDst[2] = Math.ceil(v[2]);\n      newDst[3] = Math.ceil(v[3]);\n      return newDst;\n    }\n    function floor(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.floor(v[0]);\n      newDst[1] = Math.floor(v[1]);\n      newDst[2] = Math.floor(v[2]);\n      newDst[3] = Math.floor(v[3]);\n      return newDst;\n    }\n    function round(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.round(v[0]);\n      newDst[1] = Math.round(v[1]);\n      newDst[2] = Math.round(v[2]);\n      newDst[3] = Math.round(v[3]);\n      return newDst;\n    }\n    function clamp(v, min2 = 0, max2 = 1, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.min(max2, Math.max(min2, v[0]));\n      newDst[1] = Math.min(max2, Math.max(min2, v[1]));\n      newDst[2] = Math.min(max2, Math.max(min2, v[2]));\n      newDst[3] = Math.min(max2, Math.max(min2, v[3]));\n      return newDst;\n    }\n    function add(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + b[0];\n      newDst[1] = a[1] + b[1];\n      newDst[2] = a[2] + b[2];\n      newDst[3] = a[3] + b[3];\n      return newDst;\n    }\n    function addScaled(a, b, scale2, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + b[0] * scale2;\n      newDst[1] = a[1] + b[1] * scale2;\n      newDst[2] = a[2] + b[2] * scale2;\n      newDst[3] = a[3] + b[3] * scale2;\n      return newDst;\n    }\n    function subtract(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] - b[0];\n      newDst[1] = a[1] - b[1];\n      newDst[2] = a[2] - b[2];\n      newDst[3] = a[3] - b[3];\n      return newDst;\n    }\n    const sub = subtract;\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[3] - b[3]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];\n    }\n    function lerp(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + t * (b[0] - a[0]);\n      newDst[1] = a[1] + t * (b[1] - a[1]);\n      newDst[2] = a[2] + t * (b[2] - a[2]);\n      newDst[3] = a[3] + t * (b[3] - a[3]);\n      return newDst;\n    }\n    function lerpV(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + t[0] * (b[0] - a[0]);\n      newDst[1] = a[1] + t[1] * (b[1] - a[1]);\n      newDst[2] = a[2] + t[2] * (b[2] - a[2]);\n      newDst[3] = a[3] + t[3] * (b[3] - a[3]);\n      return newDst;\n    }\n    function max(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.max(a[0], b[0]);\n      newDst[1] = Math.max(a[1], b[1]);\n      newDst[2] = Math.max(a[2], b[2]);\n      newDst[3] = Math.max(a[3], b[3]);\n      return newDst;\n    }\n    function min(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.min(a[0], b[0]);\n      newDst[1] = Math.min(a[1], b[1]);\n      newDst[2] = Math.min(a[2], b[2]);\n      newDst[3] = Math.min(a[3], b[3]);\n      return newDst;\n    }\n    function mulScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = v[0] * k;\n      newDst[1] = v[1] * k;\n      newDst[2] = v[2] * k;\n      newDst[3] = v[3] * k;\n      return newDst;\n    }\n    const scale = mulScalar;\n    function divScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = v[0] / k;\n      newDst[1] = v[1] / k;\n      newDst[2] = v[2] / k;\n      newDst[3] = v[3] / k;\n      return newDst;\n    }\n    function inverse(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = 1 / v[0];\n      newDst[1] = 1 / v[1];\n      newDst[2] = 1 / v[2];\n      newDst[3] = 1 / v[3];\n      return newDst;\n    }\n    const invert = inverse;\n    function dot(a, b) {\n      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];\n    }\n    function length(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      return Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);\n    }\n    const len = length;\n    function lengthSq(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      return v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3;\n    }\n    const lenSq = lengthSq;\n    function distance(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      const dz = a[2] - b[2];\n      const dw = a[3] - b[3];\n      return Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw);\n    }\n    const dist = distance;\n    function distanceSq(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      const dz = a[2] - b[2];\n      const dw = a[3] - b[3];\n      return dx * dx + dy * dy + dz * dz + dw * dw;\n    }\n    const distSq = distanceSq;\n    function normalize(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      const len2 = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);\n      if (len2 > 1e-5) {\n        newDst[0] = v0 / len2;\n        newDst[1] = v1 / len2;\n        newDst[2] = v2 / len2;\n        newDst[3] = v3 / len2;\n      } else {\n        newDst[0] = 0;\n        newDst[1] = 0;\n        newDst[2] = 0;\n        newDst[3] = 0;\n      }\n      return newDst;\n    }\n    function negate(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = -v[0];\n      newDst[1] = -v[1];\n      newDst[2] = -v[2];\n      newDst[3] = -v[3];\n      return newDst;\n    }\n    function copy(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = v[0];\n      newDst[1] = v[1];\n      newDst[2] = v[2];\n      newDst[3] = v[3];\n      return newDst;\n    }\n    const clone = copy;\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] * b[0];\n      newDst[1] = a[1] * b[1];\n      newDst[2] = a[2] * b[2];\n      newDst[3] = a[3] * b[3];\n      return newDst;\n    }\n    const mul = multiply;\n    function divide(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] / b[0];\n      newDst[1] = a[1] / b[1];\n      newDst[2] = a[2] / b[2];\n      newDst[3] = a[3] / b[3];\n      return newDst;\n    }\n    const div = divide;\n    function zero(dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = 0;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      return newDst;\n    }\n    function transformMat4(v, m, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const x = v[0];\n      const y = v[1];\n      const z = v[2];\n      const w = v[3];\n      newDst[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;\n      newDst[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;\n      newDst[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;\n      newDst[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;\n      return newDst;\n    }\n    function setLength(a, len2, dst) {\n      const newDst = dst ?? new Ctor(4);\n      normalize(a, newDst);\n      return mulScalar(newDst, len2, newDst);\n    }\n    function truncate(a, maxLen, dst) {\n      const newDst = dst ?? new Ctor(4);\n      if (length(a) > maxLen) {\n        return setLength(a, maxLen, newDst);\n      }\n      return copy(a, newDst);\n    }\n    function midpoint(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      return lerp(a, b, 0.5, newDst);\n    }\n    return {\n      create,\n      fromValues,\n      set,\n      ceil,\n      floor,\n      round,\n      clamp,\n      add,\n      addScaled,\n      subtract,\n      sub,\n      equalsApproximately,\n      equals,\n      lerp,\n      lerpV,\n      max,\n      min,\n      mulScalar,\n      scale,\n      divScalar,\n      inverse,\n      invert,\n      dot,\n      length,\n      len,\n      lengthSq,\n      lenSq,\n      distance,\n      dist,\n      distanceSq,\n      distSq,\n      normalize,\n      negate,\n      copy,\n      clone,\n      multiply,\n      mul,\n      divide,\n      div,\n      zero,\n      transformMat4,\n      setLength,\n      truncate,\n      midpoint\n    };\n  }\n  var cache = /* @__PURE__ */ new Map();\n  function getAPI(Ctor) {\n    let api = cache.get(Ctor);\n    if (!api) {\n      api = getAPIImpl(Ctor);\n      cache.set(Ctor, api);\n    }\n    return api;\n  }\n  function wgpuMatrixAPI(Mat3Ctor, Mat4Ctor, QuatCtor, Vec2Ctor, Vec3Ctor, Vec4Ctor) {\n    return {\n      /** @namespace mat4 */\n      mat4: getAPI$2(Mat3Ctor),\n      /** @namespace mat3 */\n      mat3: getAPI$4(Mat4Ctor),\n      /** @namespace quat */\n      quat: getAPI$1(QuatCtor),\n      /** @namespace vec2 */\n      vec2: getAPI$5(Vec2Ctor),\n      /** @namespace vec3 */\n      vec3: getAPI$3(Vec3Ctor),\n      /** @namespace vec4 */\n      vec4: getAPI(Vec4Ctor)\n    };\n  }\n  var {\n    /** @namespace */\n    mat4,\n    /** @namespace */\n    mat3,\n    /** @namespace */\n    quat,\n    /** @namespace */\n    vec2,\n    /** @namespace */\n    vec3,\n    /** @namespace */\n    vec4\n  } = wgpuMatrixAPI(Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array);\n  var {\n    /** @namespace */\n    mat4: mat4d,\n    /** @namespace */\n    mat3: mat3d,\n    /** @namespace */\n    quat: quatd,\n    /** @namespace */\n    vec2: vec2d,\n    /** @namespace */\n    vec3: vec3d,\n    /** @namespace */\n    vec4: vec4d\n  } = wgpuMatrixAPI(Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array);\n  var {\n    /** @namespace */\n    mat4: mat4n,\n    /** @namespace */\n    mat3: mat3n,\n    /** @namespace */\n    quat: quatn,\n    /** @namespace */\n    vec2: vec2n,\n    /** @namespace */\n    vec3: vec3n,\n    /** @namespace */\n    vec4: vec4n\n  } = wgpuMatrixAPI(ZeroArray, Array, Array, Array, Array, Array);\n\n  // worker_recv.ts\n  var metadataFlagIsKey = 1;\n  var wt;\n  var decoder;\n  var canvas;\n  var ctx;\n  var device;\n  var pipeline;\n  var sampler;\n  var uniBuf;\n  var uniVals;\n  var matrix;\n  var renderPassDescriptor;\n  var jitterBufLn = 256;\n  var jitterBufMask = jitterBufLn - 1;\n  var jitterBuf = new Array(jitterBufLn).fill(null).map(() => ({ frame: null, timestamp: 0, frameId: 0, metadata: 0 }));\n  var jitterBufPlayIdx = 0;\n  var jitterBufPlayIdxInit = 0;\n  var jitterBufGotFirstFrame = 0;\n  async function WebTransportAlloc() {\n    const hashBytes = Uint8Array.fromHex("8142935cf816ade736327aab0b8de1f7c00292a8abac2c1dd9c450bd3a92c8cf");\n    const ret = new WebTransport(\n      "https://127.0.0.1:4567/",\n      {\n        allowPooling: false,\n        serverCertificateHashes: [\n          {\n            algorithm: "sha-256",\n            value: hashBytes.buffer\n          }\n        ]\n      }\n    );\n    await ret.ready;\n    return ret;\n  }\n  async function UnidiCb(receiveStream) {\n    const reader = receiveStream.getReader();\n    const packetBuf = [];\n    let catBufLn = 0;\n    for (; ; ) {\n      const timeout = new Promise((resolve, _) => setTimeout(() => resolve({ skip: 1 }), 1e3));\n      const res = await Promise.race([reader.read(), timeout]);\n      if (res.skip) {\n        console.log("[recv] inner skip");\n        await reader.cancel();\n        reader.releaseLock();\n        return;\n      }\n      if (res.done) {\n        break;\n      }\n      packetBuf.push(res.value);\n      catBufLn += res.value.length;\n    }\n    let catBuf = new Uint8Array(catBufLn);\n    let catBufOff = 0;\n    for (let I = 0; I < packetBuf.length; ++I) {\n      const buf = packetBuf[I];\n      catBuf.set(buf, catBufOff);\n      catBufOff += buf.length;\n    }\n    const catView = new DataView(catBuf.buffer);\n    const headerType = catView.getUint8(0);\n    if (headerType === headerFrame) {\n      const jitterBufWriteIdx = FrameHeaderRead(catView, jitterBuf, jitterBufMask);\n      const jitterBufEl = jitterBuf[jitterBufWriteIdx];\n      jitterBufEl.frame = new EncodedVideoChunk({\n        data: new DataView(catBuf.buffer, frameHeaderLn),\n        timestamp: jitterBufEl.timestamp,\n        type: jitterBufEl.metadata & metadataFlagIsKey ? "key" : "delta"\n        // todo specify duration\n      });\n      if (!jitterBufPlayIdxInit) {\n        jitterBufPlayIdxInit = 1;\n        jitterBufPlayIdx = jitterBufWriteIdx;\n      }\n      const delta = jitterBufWriteIdx >= jitterBufPlayIdx ? jitterBufWriteIdx - jitterBufPlayIdx : jitterBufLn - jitterBufPlayIdx + jitterBufWriteIdx;\n      if (delta > 6) {\n        const decodeChunk = jitterBuf[jitterBufPlayIdx];\n        if (decodeChunk.frame) {\n          if (jitterBufGotFirstFrame || decodeChunk.metadata & metadataFlagIsKey) {\n            jitterBufGotFirstFrame = 1;\n            decoder.decode(decodeChunk.frame);\n          }\n          decodeChunk.frame = null;\n          jitterBufPlayIdx++;\n          jitterBufPlayIdx %= jitterBufMask;\n        } else {\n          console.error("[recv] Error no video chunk at play idx");\n        }\n      }\n    }\n  }\n  function DecoderCb(videoFrame) {\n    const width = videoFrame.displayWidth;\n    const height = videoFrame.displayHeight;\n    canvas.width = width;\n    canvas.height = height;\n    const fov = 90 * Math.PI / 180;\n    const aspect = width / height;\n    const zNear = 0;\n    const zFar = 2e3;\n    const projectionMatrix = mat4.perspective(fov, aspect, zNear, zFar);\n    const cameraPosition = [0, 0, 2];\n    const up = [0, 1, 0];\n    const target = [0, 0, 0];\n    const viewMatrix = mat4.lookAt(cameraPosition, target, up);\n    const viewProjectionMatrix = mat4.multiply(projectionMatrix, viewMatrix);\n    renderPassDescriptor.colorAttachments[0].view = ctx.getCurrentTexture().createView();\n    const encoder = device.createCommandEncoder();\n    const pass = encoder.beginRenderPass(renderPassDescriptor);\n    pass.setPipeline(pipeline);\n    const texture = device.importExternalTexture({ source: videoFrame });\n    const bindGroup = device.createBindGroup({\n      layout: pipeline.getBindGroupLayout(0),\n      entries: [\n        { binding: 0, resource: sampler },\n        { binding: 1, resource: texture },\n        { binding: 2, resource: uniBuf }\n      ]\n    });\n    const xSpacing = 0;\n    const ySpacing = 0;\n    const zDepth = -3;\n    const x = -0.5;\n    const y = 1;\n    mat4.translate(viewProjectionMatrix, [x * xSpacing, y * ySpacing, -zDepth * 0.5], matrix);\n    mat4.scale(matrix, [-aspect, -1, 1], matrix);\n    mat4.translate(matrix, [-0.5, -0.5, 0], matrix);\n    device.queue.writeBuffer(uniBuf, 0, uniVals);\n    pass.setBindGroup(0, bindGroup);\n    pass.draw(4);\n    pass.end();\n    const commandBuffer = encoder.finish();\n    device.queue.submit([commandBuffer]);\n    videoFrame.close();\n  }\n  function DecoderErrCb(err) {\n    console.error(err);\n  }\n  async function WorkerMsgCb(msg) {\n    canvas = msg.data.canvas;\n    ctx = canvas.getContext("webgpu");\n    const adapter = await navigator.gpu?.requestAdapter();\n    device = await adapter?.requestDevice();\n    if (!device) {\n      console.error("need a browser that supports WebGPU");\n      return;\n    }\n    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();\n    ctx.configure({\n      device,\n      format: presentationFormat\n    });\n    const module = device.createShaderModule({\n      label: "hardcoded shaders",\n      code: `\n   struct vs_out\n   {\n    @builtin(position) position: vec4f,\n    @location(0) texcoord: vec2f,\n   };\n\n   struct uniforms\n   {\n    matrix: mat4x4f,\n   };\n\n   @group(0) @binding(2) var<uniform> uni: uniforms;\n\n   @vertex fn vs(\n    @builtin(vertex_index) vertexIndex : u32\n   ) -> vs_out\n   {\n    let pos = array(\n     vec2f(0.0, 0.0),\n     vec2f(1.0, 0.0),\n     vec2f(0.0, 1.0),\n     vec2f(1.0, 1.0),\n    );\n\n    var vsOutput: vs_out;\n    let xy = pos[vertexIndex];\n    vsOutput.position = uni.matrix * vec4f(xy, 0.0, 1.0);\n    vsOutput.texcoord = xy;\n    return vsOutput;\n   }\n\n   @group(0) @binding(0) var ourSampler: sampler;\n   @group(0) @binding(1) var ourTexture: texture_external;\n\n   @fragment fn fs(fsInput: vs_out) -> @location(0) vec4f\n   {\n    return textureSampleBaseClampToEdge(\n     ourTexture,\n     ourSampler,\n     fsInput.texcoord,\n    );\n   }\n  `\n    });\n    pipeline = device.createRenderPipeline({\n      label: "my pipeline",\n      layout: "auto",\n      vertex: { module },\n      fragment: {\n        module,\n        targets: [{ format: presentationFormat }]\n      },\n      primitive: {\n        cullMode: "back",\n        frontFace: "ccw",\n        stripIndexFormat: "uint16",\n        topology: "triangle-strip",\n        unclippedDepth: false\n      }\n    });\n    sampler = device.createSampler({\n      addressModeU: "repeat",\n      addressModeV: "repeat",\n      magFilter: "linear",\n      minFilter: "linear"\n    });\n    const uniLn = 16 * 4;\n    uniBuf = device.createBuffer({\n      label: "my uni",\n      size: uniLn,\n      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST\n    });\n    uniVals = new Float32Array(uniLn / 4);\n    matrix = uniVals.subarray(0, 16);\n    renderPassDescriptor = {\n      colorAttachments: [\n        {\n          view: null,\n          clearValue: [0.3, 0.3, 0.3, 1],\n          loadOp: "clear",\n          storeOp: "store"\n        }\n      ]\n    };\n    {\n      const texView = ctx.getCurrentTexture().createView();\n      const encoder = device.createCommandEncoder();\n      const pass = encoder.beginRenderPass({\n        colorAttachments: [\n          {\n            view: texView,\n            clearValue: [0.3, 0.3, 0.3, 1],\n            loadOp: "clear",\n            storeOp: "store"\n          }\n        ]\n      });\n      pass.end();\n      device.queue.submit([encoder.finish()]);\n    }\n    wt = await WebTransportAlloc();\n    let reader = wt.incomingUnidirectionalStreams.getReader();\n    decoder = new VideoDecoder({ output: DecoderCb, error: DecoderErrCb });\n    decoder.configure({\n      codec: "vp8",\n      optimizeForLatency: true\n      // todo chrome doesn\'t like this:\n      // hardwareAcceleration: "prefer-hardware",\n      // codedHeight: 720,\n      // codedWidth: 1280,\n    });\n    for (; ; ) {\n      const timeout = new Promise((resolve, _) => setTimeout(() => resolve({ skip: 1 }), 5e3));\n      const res = await Promise.race([reader.read(), timeout]);\n      if (res.skip) {\n        console.log("[recv] timeout - skipping");\n        await reader.cancel();\n        reader.releaseLock();\n        wt.close();\n        wt = await WebTransportAlloc();\n        reader = wt.incomingUnidirectionalStreams.getReader();\n        continue;\n      }\n      if (res.done) {\n        break;\n      }\n      await UnidiCb(res.value);\n    }\n    console.log("[recv] exited");\n  }\n  function WorkerErrCb(err) {\n    console.error(err);\n  }\n  onmessage = WorkerMsgCb;\n  onerror = WorkerErrCb;\n})();\n';

  // worker_net.txt
  var worker_net_default = '"use strict";\n(() => {\n  // util.ts\n  var sendOrderDefault = 1;\n  var sendOrderKeyframe = 5;\n  var headerFrame = 0;\n  var frameHeaderLn = 11;\n  function FrameHeaderWrite(v, frameId2, timestampUs, trackId, metadata) {\n    v.setUint8(0, headerFrame);\n    v.setUint32(1, frameId2, true);\n    v.setUint32(5, timestampUs, true);\n    v.setUint8(9, trackId);\n    v.setUint8(10, metadata);\n  }\n  var AUDIO_WORKLET_CODE = `\nclass AudioCaptureProcessor extends AudioWorkletProcessor {\n  sampleCount = 0;\n\n  process(inputs) {\n    if (inputs.length === 0 || inputs[0].length === 0) {\n      return true;\n    }\n\n    const channels = inputs[0];\n    const timestamp = (this.sampleCount / sampleRate) * 1_000_000; // Convert to microseconds\n\n    this.port.postMessage({\n      timestamp,\n      channels: channels.map(channel => channel.slice()),\n    });\n\n    this.sampleCount += channels[0].length;\n    return true;\n  }\n}\n\nregisterProcessor(\'audio-capture-processor\', AudioCaptureProcessor);\n`;\n  var MediaStreamTrackProcessorPolyfill = class {\n    readable;\n    constructor({ track }) {\n      const settings = track.getSettings();\n      if (!settings) {\n        throw new Error("track has no settings");\n      }\n      if (track.kind === "video") {\n        this.readable = this.createVideoStream(track, settings);\n      } else if (track.kind === "audio") {\n        this.readable = this.createAudioStream(track, settings);\n      } else {\n        throw new Error(`Unsupported track kind: ${track.kind}`);\n      }\n    }\n    createVideoStream(track, settings) {\n      let video;\n      let last;\n      let lastDuration;\n      const frameRate = settings.frameRate ?? 30;\n      return new ReadableStream({\n        async start() {\n          video = document.createElement("video");\n          video.srcObject = new MediaStream([track]);\n          await Promise.all([\n            video.play(),\n            new Promise((r) => {\n              video.onloadedmetadata = r;\n            })\n          ]);\n          last = performance.now();\n        },\n        async pull(controller) {\n          while (true) {\n            const now = performance.now();\n            if (now - last < 1e3 / frameRate) {\n              await new Promise((r) => requestAnimationFrame(r));\n              continue;\n            }\n            const duration = lastDuration ?? Math.round((now - last) * 1e3);\n            lastDuration = duration;\n            last = now;\n            controller.enqueue(new VideoFrame(video, {\n              timestamp: last * 1e3,\n              duration\n            }));\n            break;\n          }\n        }\n      });\n    }\n    createAudioStream(track, settings) {\n      let audioContext;\n      let workletNode;\n      let workletUrl;\n      return new ReadableStream({\n        async start(controller) {\n          audioContext = new AudioContext({\n            sampleRate: settings.sampleRate || 48e3\n          });\n          const source = new MediaStreamAudioSourceNode(audioContext, {\n            mediaStream: new MediaStream([track])\n          });\n          const blob = new Blob([AUDIO_WORKLET_CODE], { type: "application/javascript" });\n          workletUrl = URL.createObjectURL(blob);\n          await audioContext.audioWorklet.addModule(workletUrl);\n          workletNode = new AudioWorkletNode(audioContext, "audio-capture-processor", {\n            numberOfInputs: 1,\n            numberOfOutputs: 0,\n            channelCount: settings.channelCount || 2\n          });\n          source.connect(workletNode);\n          workletNode.port.onmessage = (event) => {\n            const { timestamp, channels } = event.data;\n            const channelData = channels;\n            const numberOfFrames = channelData[0].length;\n            const numberOfChannels = channelData.length;\n            const totalLength = numberOfFrames * numberOfChannels;\n            const buffer = new Float32Array(totalLength);\n            for (let i = 0; i < numberOfChannels; i++) {\n              buffer.set(channelData[i], i * numberOfFrames);\n            }\n            try {\n              const audioData = new AudioData({\n                format: "f32-planar",\n                sampleRate: audioContext.sampleRate,\n                numberOfFrames,\n                numberOfChannels,\n                timestamp,\n                data: buffer\n              });\n              controller.enqueue(audioData);\n            } catch (e) {\n              console.error("Failed to create AudioData:", e);\n            }\n          };\n        },\n        cancel() {\n          if (workletNode) {\n            workletNode.disconnect();\n            workletNode.port.onmessage = null;\n          }\n          if (audioContext) {\n            audioContext.close();\n          }\n          if (workletUrl) {\n            URL.revokeObjectURL(workletUrl);\n          }\n        }\n      });\n    }\n  };\n  if (!self.MediaStreamTrackProcessor) {\n    self.MediaStreamTrackProcessor = MediaStreamTrackProcessorPolyfill;\n  }\n  var MediaStreamTrackProcessor = self.MediaStreamTrackProcessor || MediaStreamTrackProcessorPolyfill;\n  function wrapConstructor(OriginalConstructor, modifier) {\n    return class extends OriginalConstructor {\n      constructor(...args) {\n        super(...args);\n        modifier(this);\n      }\n    };\n  }\n  var ZeroArray = wrapConstructor(Array, (a) => a.fill(0));\n  var EPSILON = 1e-6;\n  function getAPIImpl$5(Ctor) {\n    function create(x = 0, y = 0) {\n      const newDst = new Ctor(2);\n      if (x !== void 0) {\n        newDst[0] = x;\n        if (y !== void 0) {\n          newDst[1] = y;\n        }\n      }\n      return newDst;\n    }\n    const fromValues = create;\n    function set(x, y, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = x;\n      newDst[1] = y;\n      return newDst;\n    }\n    function ceil(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.ceil(v[0]);\n      newDst[1] = Math.ceil(v[1]);\n      return newDst;\n    }\n    function floor(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.floor(v[0]);\n      newDst[1] = Math.floor(v[1]);\n      return newDst;\n    }\n    function round(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.round(v[0]);\n      newDst[1] = Math.round(v[1]);\n      return newDst;\n    }\n    function clamp(v, min2 = 0, max2 = 1, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.min(max2, Math.max(min2, v[0]));\n      newDst[1] = Math.min(max2, Math.max(min2, v[1]));\n      return newDst;\n    }\n    function add(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] + b[0];\n      newDst[1] = a[1] + b[1];\n      return newDst;\n    }\n    function addScaled(a, b, scale2, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] + b[0] * scale2;\n      newDst[1] = a[1] + b[1] * scale2;\n      return newDst;\n    }\n    function angle(a, b) {\n      const ax = a[0];\n      const ay = a[1];\n      const bx = b[0];\n      const by = b[1];\n      const mag1 = Math.sqrt(ax * ax + ay * ay);\n      const mag2 = Math.sqrt(bx * bx + by * by);\n      const mag = mag1 * mag2;\n      const cosine = mag && dot(a, b) / mag;\n      return Math.acos(cosine);\n    }\n    function subtract(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] - b[0];\n      newDst[1] = a[1] - b[1];\n      return newDst;\n    }\n    const sub = subtract;\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1];\n    }\n    function lerp(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] + t * (b[0] - a[0]);\n      newDst[1] = a[1] + t * (b[1] - a[1]);\n      return newDst;\n    }\n    function lerpV(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] + t[0] * (b[0] - a[0]);\n      newDst[1] = a[1] + t[1] * (b[1] - a[1]);\n      return newDst;\n    }\n    function max(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.max(a[0], b[0]);\n      newDst[1] = Math.max(a[1], b[1]);\n      return newDst;\n    }\n    function min(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = Math.min(a[0], b[0]);\n      newDst[1] = Math.min(a[1], b[1]);\n      return newDst;\n    }\n    function mulScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = v[0] * k;\n      newDst[1] = v[1] * k;\n      return newDst;\n    }\n    const scale = mulScalar;\n    function divScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = v[0] / k;\n      newDst[1] = v[1] / k;\n      return newDst;\n    }\n    function inverse(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = 1 / v[0];\n      newDst[1] = 1 / v[1];\n      return newDst;\n    }\n    const invert = inverse;\n    function cross(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const z = a[0] * b[1] - a[1] * b[0];\n      newDst[0] = 0;\n      newDst[1] = 0;\n      newDst[2] = z;\n      return newDst;\n    }\n    function dot(a, b) {\n      return a[0] * b[0] + a[1] * b[1];\n    }\n    function length(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      return Math.sqrt(v0 * v0 + v1 * v1);\n    }\n    const len = length;\n    function lengthSq(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      return v0 * v0 + v1 * v1;\n    }\n    const lenSq = lengthSq;\n    function distance(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      return Math.sqrt(dx * dx + dy * dy);\n    }\n    const dist = distance;\n    function distanceSq(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      return dx * dx + dy * dy;\n    }\n    const distSq = distanceSq;\n    function normalize(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      const v0 = v[0];\n      const v1 = v[1];\n      const len2 = Math.sqrt(v0 * v0 + v1 * v1);\n      if (len2 > 1e-5) {\n        newDst[0] = v0 / len2;\n        newDst[1] = v1 / len2;\n      } else {\n        newDst[0] = 0;\n        newDst[1] = 0;\n      }\n      return newDst;\n    }\n    function negate(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = -v[0];\n      newDst[1] = -v[1];\n      return newDst;\n    }\n    function copy(v, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = v[0];\n      newDst[1] = v[1];\n      return newDst;\n    }\n    const clone = copy;\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] * b[0];\n      newDst[1] = a[1] * b[1];\n      return newDst;\n    }\n    const mul = multiply;\n    function divide(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = a[0] / b[0];\n      newDst[1] = a[1] / b[1];\n      return newDst;\n    }\n    const div = divide;\n    function random(scale2 = 1, dst) {\n      const newDst = dst ?? new Ctor(2);\n      const angle2 = Math.random() * 2 * Math.PI;\n      newDst[0] = Math.cos(angle2) * scale2;\n      newDst[1] = Math.sin(angle2) * scale2;\n      return newDst;\n    }\n    function zero(dst) {\n      const newDst = dst ?? new Ctor(2);\n      newDst[0] = 0;\n      newDst[1] = 0;\n      return newDst;\n    }\n    function transformMat4(v, m, dst) {\n      const newDst = dst ?? new Ctor(2);\n      const x = v[0];\n      const y = v[1];\n      newDst[0] = x * m[0] + y * m[4] + m[12];\n      newDst[1] = x * m[1] + y * m[5] + m[13];\n      return newDst;\n    }\n    function transformMat3(v, m, dst) {\n      const newDst = dst ?? new Ctor(2);\n      const x = v[0];\n      const y = v[1];\n      newDst[0] = m[0] * x + m[4] * y + m[8];\n      newDst[1] = m[1] * x + m[5] * y + m[9];\n      return newDst;\n    }\n    function rotate(a, b, rad, dst) {\n      const newDst = dst ?? new Ctor(2);\n      const p0 = a[0] - b[0];\n      const p1 = a[1] - b[1];\n      const sinC = Math.sin(rad);\n      const cosC = Math.cos(rad);\n      newDst[0] = p0 * cosC - p1 * sinC + b[0];\n      newDst[1] = p0 * sinC + p1 * cosC + b[1];\n      return newDst;\n    }\n    function setLength(a, len2, dst) {\n      const newDst = dst ?? new Ctor(2);\n      normalize(a, newDst);\n      return mulScalar(newDst, len2, newDst);\n    }\n    function truncate(a, maxLen, dst) {\n      const newDst = dst ?? new Ctor(2);\n      if (length(a) > maxLen) {\n        return setLength(a, maxLen, newDst);\n      }\n      return copy(a, newDst);\n    }\n    function midpoint(a, b, dst) {\n      const newDst = dst ?? new Ctor(2);\n      return lerp(a, b, 0.5, newDst);\n    }\n    return {\n      create,\n      fromValues,\n      set,\n      ceil,\n      floor,\n      round,\n      clamp,\n      add,\n      addScaled,\n      angle,\n      subtract,\n      sub,\n      equalsApproximately,\n      equals,\n      lerp,\n      lerpV,\n      max,\n      min,\n      mulScalar,\n      scale,\n      divScalar,\n      inverse,\n      invert,\n      cross,\n      dot,\n      length,\n      len,\n      lengthSq,\n      lenSq,\n      distance,\n      dist,\n      distanceSq,\n      distSq,\n      normalize,\n      negate,\n      copy,\n      clone,\n      multiply,\n      mul,\n      divide,\n      div,\n      random,\n      zero,\n      transformMat4,\n      transformMat3,\n      rotate,\n      setLength,\n      truncate,\n      midpoint\n    };\n  }\n  var cache$5 = /* @__PURE__ */ new Map();\n  function getAPI$5(Ctor) {\n    let api = cache$5.get(Ctor);\n    if (!api) {\n      api = getAPIImpl$5(Ctor);\n      cache$5.set(Ctor, api);\n    }\n    return api;\n  }\n  function getAPIImpl$4(Ctor) {\n    const vec22 = getAPI$5(Ctor);\n    function create(v0, v1, v2, v3, v4, v5, v6, v7, v8) {\n      const newDst = new Ctor(12);\n      newDst[3] = 0;\n      newDst[7] = 0;\n      newDst[11] = 0;\n      if (v0 !== void 0) {\n        newDst[0] = v0;\n        if (v1 !== void 0) {\n          newDst[1] = v1;\n          if (v2 !== void 0) {\n            newDst[2] = v2;\n            if (v3 !== void 0) {\n              newDst[4] = v3;\n              if (v4 !== void 0) {\n                newDst[5] = v4;\n                if (v5 !== void 0) {\n                  newDst[6] = v5;\n                  if (v6 !== void 0) {\n                    newDst[8] = v6;\n                    if (v7 !== void 0) {\n                      newDst[9] = v7;\n                      if (v8 !== void 0) {\n                        newDst[10] = v8;\n                      }\n                    }\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n      return newDst;\n    }\n    function set(v0, v1, v2, v3, v4, v5, v6, v7, v8, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = v0;\n      newDst[1] = v1;\n      newDst[2] = v2;\n      newDst[3] = 0;\n      newDst[4] = v3;\n      newDst[5] = v4;\n      newDst[6] = v5;\n      newDst[7] = 0;\n      newDst[8] = v6;\n      newDst[9] = v7;\n      newDst[10] = v8;\n      newDst[11] = 0;\n      return newDst;\n    }\n    function fromMat4(m4, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = m4[0];\n      newDst[1] = m4[1];\n      newDst[2] = m4[2];\n      newDst[3] = 0;\n      newDst[4] = m4[4];\n      newDst[5] = m4[5];\n      newDst[6] = m4[6];\n      newDst[7] = 0;\n      newDst[8] = m4[8];\n      newDst[9] = m4[9];\n      newDst[10] = m4[10];\n      newDst[11] = 0;\n      return newDst;\n    }\n    function fromQuat(q, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const x = q[0];\n      const y = q[1];\n      const z = q[2];\n      const w = q[3];\n      const x2 = x + x;\n      const y2 = y + y;\n      const z2 = z + z;\n      const xx = x * x2;\n      const yx = y * x2;\n      const yy = y * y2;\n      const zx = z * x2;\n      const zy = z * y2;\n      const zz = z * z2;\n      const wx = w * x2;\n      const wy = w * y2;\n      const wz = w * z2;\n      newDst[0] = 1 - yy - zz;\n      newDst[1] = yx + wz;\n      newDst[2] = zx - wy;\n      newDst[3] = 0;\n      newDst[4] = yx - wz;\n      newDst[5] = 1 - xx - zz;\n      newDst[6] = zy + wx;\n      newDst[7] = 0;\n      newDst[8] = zx + wy;\n      newDst[9] = zy - wx;\n      newDst[10] = 1 - xx - yy;\n      newDst[11] = 0;\n      return newDst;\n    }\n    function negate(m, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = -m[0];\n      newDst[1] = -m[1];\n      newDst[2] = -m[2];\n      newDst[4] = -m[4];\n      newDst[5] = -m[5];\n      newDst[6] = -m[6];\n      newDst[8] = -m[8];\n      newDst[9] = -m[9];\n      newDst[10] = -m[10];\n      return newDst;\n    }\n    function copy(m, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = m[0];\n      newDst[1] = m[1];\n      newDst[2] = m[2];\n      newDst[4] = m[4];\n      newDst[5] = m[5];\n      newDst[6] = m[6];\n      newDst[8] = m[8];\n      newDst[9] = m[9];\n      newDst[10] = m[10];\n      return newDst;\n    }\n    const clone = copy;\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[4] - b[4]) < EPSILON && Math.abs(a[5] - b[5]) < EPSILON && Math.abs(a[6] - b[6]) < EPSILON && Math.abs(a[8] - b[8]) < EPSILON && Math.abs(a[9] - b[9]) < EPSILON && Math.abs(a[10] - b[10]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[4] === b[4] && a[5] === b[5] && a[6] === b[6] && a[8] === b[8] && a[9] === b[9] && a[10] === b[10];\n    }\n    function identity(dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = 1;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[4] = 0;\n      newDst[5] = 1;\n      newDst[6] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      return newDst;\n    }\n    function transpose(m, dst) {\n      const newDst = dst ?? new Ctor(12);\n      if (newDst === m) {\n        let t;\n        t = m[1];\n        m[1] = m[4];\n        m[4] = t;\n        t = m[2];\n        m[2] = m[8];\n        m[8] = t;\n        t = m[6];\n        m[6] = m[9];\n        m[9] = t;\n        return newDst;\n      }\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      newDst[0] = m00;\n      newDst[1] = m10;\n      newDst[2] = m20;\n      newDst[4] = m01;\n      newDst[5] = m11;\n      newDst[6] = m21;\n      newDst[8] = m02;\n      newDst[9] = m12;\n      newDst[10] = m22;\n      return newDst;\n    }\n    function inverse(m, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const b01 = m22 * m11 - m12 * m21;\n      const b11 = -m22 * m10 + m12 * m20;\n      const b21 = m21 * m10 - m11 * m20;\n      const invDet = 1 / (m00 * b01 + m01 * b11 + m02 * b21);\n      newDst[0] = b01 * invDet;\n      newDst[1] = (-m22 * m01 + m02 * m21) * invDet;\n      newDst[2] = (m12 * m01 - m02 * m11) * invDet;\n      newDst[4] = b11 * invDet;\n      newDst[5] = (m22 * m00 - m02 * m20) * invDet;\n      newDst[6] = (-m12 * m00 + m02 * m10) * invDet;\n      newDst[8] = b21 * invDet;\n      newDst[9] = (-m21 * m00 + m01 * m20) * invDet;\n      newDst[10] = (m11 * m00 - m01 * m10) * invDet;\n      return newDst;\n    }\n    function determinant(m) {\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      return m00 * (m11 * m22 - m21 * m12) - m10 * (m01 * m22 - m21 * m02) + m20 * (m01 * m12 - m11 * m02);\n    }\n    const invert = inverse;\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const a00 = a[0];\n      const a01 = a[1];\n      const a02 = a[2];\n      const a10 = a[4 + 0];\n      const a11 = a[4 + 1];\n      const a12 = a[4 + 2];\n      const a20 = a[8 + 0];\n      const a21 = a[8 + 1];\n      const a22 = a[8 + 2];\n      const b00 = b[0];\n      const b01 = b[1];\n      const b02 = b[2];\n      const b10 = b[4 + 0];\n      const b11 = b[4 + 1];\n      const b12 = b[4 + 2];\n      const b20 = b[8 + 0];\n      const b21 = b[8 + 1];\n      const b22 = b[8 + 2];\n      newDst[0] = a00 * b00 + a10 * b01 + a20 * b02;\n      newDst[1] = a01 * b00 + a11 * b01 + a21 * b02;\n      newDst[2] = a02 * b00 + a12 * b01 + a22 * b02;\n      newDst[4] = a00 * b10 + a10 * b11 + a20 * b12;\n      newDst[5] = a01 * b10 + a11 * b11 + a21 * b12;\n      newDst[6] = a02 * b10 + a12 * b11 + a22 * b12;\n      newDst[8] = a00 * b20 + a10 * b21 + a20 * b22;\n      newDst[9] = a01 * b20 + a11 * b21 + a21 * b22;\n      newDst[10] = a02 * b20 + a12 * b21 + a22 * b22;\n      return newDst;\n    }\n    const mul = multiply;\n    function setTranslation(a, v, dst) {\n      const newDst = dst ?? identity();\n      if (a !== newDst) {\n        newDst[0] = a[0];\n        newDst[1] = a[1];\n        newDst[2] = a[2];\n        newDst[4] = a[4];\n        newDst[5] = a[5];\n        newDst[6] = a[6];\n      }\n      newDst[8] = v[0];\n      newDst[9] = v[1];\n      newDst[10] = 1;\n      return newDst;\n    }\n    function getTranslation(m, dst) {\n      const newDst = dst ?? vec22.create();\n      newDst[0] = m[8];\n      newDst[1] = m[9];\n      return newDst;\n    }\n    function getAxis(m, axis, dst) {\n      const newDst = dst ?? vec22.create();\n      const off = axis * 4;\n      newDst[0] = m[off + 0];\n      newDst[1] = m[off + 1];\n      return newDst;\n    }\n    function setAxis(m, v, axis, dst) {\n      const newDst = dst === m ? m : copy(m, dst);\n      const off = axis * 4;\n      newDst[off + 0] = v[0];\n      newDst[off + 1] = v[1];\n      return newDst;\n    }\n    function getScaling(m, dst) {\n      const newDst = dst ?? vec22.create();\n      const xx = m[0];\n      const xy = m[1];\n      const yx = m[4];\n      const yy = m[5];\n      newDst[0] = Math.sqrt(xx * xx + xy * xy);\n      newDst[1] = Math.sqrt(yx * yx + yy * yy);\n      return newDst;\n    }\n    function translation(v, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = 1;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[4] = 0;\n      newDst[5] = 1;\n      newDst[6] = 0;\n      newDst[8] = v[0];\n      newDst[9] = v[1];\n      newDst[10] = 1;\n      return newDst;\n    }\n    function translate(m, v, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const v0 = v[0];\n      const v1 = v[1];\n      const m00 = m[0];\n      const m01 = m[1];\n      const m02 = m[2];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      if (m !== newDst) {\n        newDst[0] = m00;\n        newDst[1] = m01;\n        newDst[2] = m02;\n        newDst[4] = m10;\n        newDst[5] = m11;\n        newDst[6] = m12;\n      }\n      newDst[8] = m00 * v0 + m10 * v1 + m20;\n      newDst[9] = m01 * v0 + m11 * v1 + m21;\n      newDst[10] = m02 * v0 + m12 * v1 + m22;\n      return newDst;\n    }\n    function rotation(angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c;\n      newDst[1] = s;\n      newDst[2] = 0;\n      newDst[4] = -s;\n      newDst[5] = c;\n      newDst[6] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      return newDst;\n    }\n    function rotate(m, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c * m00 + s * m10;\n      newDst[1] = c * m01 + s * m11;\n      newDst[2] = c * m02 + s * m12;\n      newDst[4] = c * m10 - s * m00;\n      newDst[5] = c * m11 - s * m01;\n      newDst[6] = c * m12 - s * m02;\n      if (m !== newDst) {\n        newDst[8] = m[8];\n        newDst[9] = m[9];\n        newDst[10] = m[10];\n      }\n      return newDst;\n    }\n    function scaling(v, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = v[0];\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[4] = 0;\n      newDst[5] = v[1];\n      newDst[6] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      return newDst;\n    }\n    function scale(m, v, dst) {\n      const newDst = dst ?? new Ctor(12);\n      const v0 = v[0];\n      const v1 = v[1];\n      newDst[0] = v0 * m[0 * 4 + 0];\n      newDst[1] = v0 * m[0 * 4 + 1];\n      newDst[2] = v0 * m[0 * 4 + 2];\n      newDst[4] = v1 * m[1 * 4 + 0];\n      newDst[5] = v1 * m[1 * 4 + 1];\n      newDst[6] = v1 * m[1 * 4 + 2];\n      if (m !== newDst) {\n        newDst[8] = m[8];\n        newDst[9] = m[9];\n        newDst[10] = m[10];\n      }\n      return newDst;\n    }\n    function uniformScaling(s, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = s;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[4] = 0;\n      newDst[5] = s;\n      newDst[6] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      return newDst;\n    }\n    function uniformScale(m, s, dst) {\n      const newDst = dst ?? new Ctor(12);\n      newDst[0] = s * m[0 * 4 + 0];\n      newDst[1] = s * m[0 * 4 + 1];\n      newDst[2] = s * m[0 * 4 + 2];\n      newDst[4] = s * m[1 * 4 + 0];\n      newDst[5] = s * m[1 * 4 + 1];\n      newDst[6] = s * m[1 * 4 + 2];\n      if (m !== newDst) {\n        newDst[8] = m[8];\n        newDst[9] = m[9];\n        newDst[10] = m[10];\n      }\n      return newDst;\n    }\n    return {\n      clone,\n      create,\n      set,\n      fromMat4,\n      fromQuat,\n      negate,\n      copy,\n      equalsApproximately,\n      equals,\n      identity,\n      transpose,\n      inverse,\n      invert,\n      determinant,\n      mul,\n      multiply,\n      setTranslation,\n      getTranslation,\n      getAxis,\n      setAxis,\n      getScaling,\n      translation,\n      translate,\n      rotation,\n      rotate,\n      scaling,\n      scale,\n      uniformScaling,\n      uniformScale\n    };\n  }\n  var cache$4 = /* @__PURE__ */ new Map();\n  function getAPI$4(Ctor) {\n    let api = cache$4.get(Ctor);\n    if (!api) {\n      api = getAPIImpl$4(Ctor);\n      cache$4.set(Ctor, api);\n    }\n    return api;\n  }\n  function getAPIImpl$3(Ctor) {\n    function create(x, y, z) {\n      const newDst = new Ctor(3);\n      if (x !== void 0) {\n        newDst[0] = x;\n        if (y !== void 0) {\n          newDst[1] = y;\n          if (z !== void 0) {\n            newDst[2] = z;\n          }\n        }\n      }\n      return newDst;\n    }\n    const fromValues = create;\n    function set(x, y, z, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = x;\n      newDst[1] = y;\n      newDst[2] = z;\n      return newDst;\n    }\n    function ceil(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.ceil(v[0]);\n      newDst[1] = Math.ceil(v[1]);\n      newDst[2] = Math.ceil(v[2]);\n      return newDst;\n    }\n    function floor(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.floor(v[0]);\n      newDst[1] = Math.floor(v[1]);\n      newDst[2] = Math.floor(v[2]);\n      return newDst;\n    }\n    function round(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.round(v[0]);\n      newDst[1] = Math.round(v[1]);\n      newDst[2] = Math.round(v[2]);\n      return newDst;\n    }\n    function clamp(v, min2 = 0, max2 = 1, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.min(max2, Math.max(min2, v[0]));\n      newDst[1] = Math.min(max2, Math.max(min2, v[1]));\n      newDst[2] = Math.min(max2, Math.max(min2, v[2]));\n      return newDst;\n    }\n    function add(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] + b[0];\n      newDst[1] = a[1] + b[1];\n      newDst[2] = a[2] + b[2];\n      return newDst;\n    }\n    function addScaled(a, b, scale2, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] + b[0] * scale2;\n      newDst[1] = a[1] + b[1] * scale2;\n      newDst[2] = a[2] + b[2] * scale2;\n      return newDst;\n    }\n    function angle(a, b) {\n      const ax = a[0];\n      const ay = a[1];\n      const az = a[2];\n      const bx = b[0];\n      const by = b[1];\n      const bz = b[2];\n      const mag1 = Math.sqrt(ax * ax + ay * ay + az * az);\n      const mag2 = Math.sqrt(bx * bx + by * by + bz * bz);\n      const mag = mag1 * mag2;\n      const cosine = mag && dot(a, b) / mag;\n      return Math.acos(cosine);\n    }\n    function subtract(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] - b[0];\n      newDst[1] = a[1] - b[1];\n      newDst[2] = a[2] - b[2];\n      return newDst;\n    }\n    const sub = subtract;\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];\n    }\n    function lerp(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] + t * (b[0] - a[0]);\n      newDst[1] = a[1] + t * (b[1] - a[1]);\n      newDst[2] = a[2] + t * (b[2] - a[2]);\n      return newDst;\n    }\n    function lerpV(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] + t[0] * (b[0] - a[0]);\n      newDst[1] = a[1] + t[1] * (b[1] - a[1]);\n      newDst[2] = a[2] + t[2] * (b[2] - a[2]);\n      return newDst;\n    }\n    function max(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.max(a[0], b[0]);\n      newDst[1] = Math.max(a[1], b[1]);\n      newDst[2] = Math.max(a[2], b[2]);\n      return newDst;\n    }\n    function min(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = Math.min(a[0], b[0]);\n      newDst[1] = Math.min(a[1], b[1]);\n      newDst[2] = Math.min(a[2], b[2]);\n      return newDst;\n    }\n    function mulScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = v[0] * k;\n      newDst[1] = v[1] * k;\n      newDst[2] = v[2] * k;\n      return newDst;\n    }\n    const scale = mulScalar;\n    function divScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = v[0] / k;\n      newDst[1] = v[1] / k;\n      newDst[2] = v[2] / k;\n      return newDst;\n    }\n    function inverse(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = 1 / v[0];\n      newDst[1] = 1 / v[1];\n      newDst[2] = 1 / v[2];\n      return newDst;\n    }\n    const invert = inverse;\n    function cross(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const t1 = a[2] * b[0] - a[0] * b[2];\n      const t2 = a[0] * b[1] - a[1] * b[0];\n      newDst[0] = a[1] * b[2] - a[2] * b[1];\n      newDst[1] = t1;\n      newDst[2] = t2;\n      return newDst;\n    }\n    function dot(a, b) {\n      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];\n    }\n    function length(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      return Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2);\n    }\n    const len = length;\n    function lengthSq(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      return v0 * v0 + v1 * v1 + v2 * v2;\n    }\n    const lenSq = lengthSq;\n    function distance(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      const dz = a[2] - b[2];\n      return Math.sqrt(dx * dx + dy * dy + dz * dz);\n    }\n    const dist = distance;\n    function distanceSq(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      const dz = a[2] - b[2];\n      return dx * dx + dy * dy + dz * dz;\n    }\n    const distSq = distanceSq;\n    function normalize(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const len2 = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2);\n      if (len2 > 1e-5) {\n        newDst[0] = v0 / len2;\n        newDst[1] = v1 / len2;\n        newDst[2] = v2 / len2;\n      } else {\n        newDst[0] = 0;\n        newDst[1] = 0;\n        newDst[2] = 0;\n      }\n      return newDst;\n    }\n    function negate(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = -v[0];\n      newDst[1] = -v[1];\n      newDst[2] = -v[2];\n      return newDst;\n    }\n    function copy(v, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = v[0];\n      newDst[1] = v[1];\n      newDst[2] = v[2];\n      return newDst;\n    }\n    const clone = copy;\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] * b[0];\n      newDst[1] = a[1] * b[1];\n      newDst[2] = a[2] * b[2];\n      return newDst;\n    }\n    const mul = multiply;\n    function divide(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = a[0] / b[0];\n      newDst[1] = a[1] / b[1];\n      newDst[2] = a[2] / b[2];\n      return newDst;\n    }\n    const div = divide;\n    function random(scale2 = 1, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const angle2 = Math.random() * 2 * Math.PI;\n      const z = Math.random() * 2 - 1;\n      const zScale = Math.sqrt(1 - z * z) * scale2;\n      newDst[0] = Math.cos(angle2) * zScale;\n      newDst[1] = Math.sin(angle2) * zScale;\n      newDst[2] = z * scale2;\n      return newDst;\n    }\n    function zero(dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = 0;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      return newDst;\n    }\n    function transformMat4(v, m, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const x = v[0];\n      const y = v[1];\n      const z = v[2];\n      const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;\n      newDst[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;\n      newDst[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;\n      newDst[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;\n      return newDst;\n    }\n    function transformMat4Upper3x3(v, m, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      newDst[0] = v0 * m[0 * 4 + 0] + v1 * m[1 * 4 + 0] + v2 * m[2 * 4 + 0];\n      newDst[1] = v0 * m[0 * 4 + 1] + v1 * m[1 * 4 + 1] + v2 * m[2 * 4 + 1];\n      newDst[2] = v0 * m[0 * 4 + 2] + v1 * m[1 * 4 + 2] + v2 * m[2 * 4 + 2];\n      return newDst;\n    }\n    function transformMat3(v, m, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const x = v[0];\n      const y = v[1];\n      const z = v[2];\n      newDst[0] = x * m[0] + y * m[4] + z * m[8];\n      newDst[1] = x * m[1] + y * m[5] + z * m[9];\n      newDst[2] = x * m[2] + y * m[6] + z * m[10];\n      return newDst;\n    }\n    function transformQuat(v, q, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const qx = q[0];\n      const qy = q[1];\n      const qz = q[2];\n      const w2 = q[3] * 2;\n      const x = v[0];\n      const y = v[1];\n      const z = v[2];\n      const uvX = qy * z - qz * y;\n      const uvY = qz * x - qx * z;\n      const uvZ = qx * y - qy * x;\n      newDst[0] = x + uvX * w2 + (qy * uvZ - qz * uvY) * 2;\n      newDst[1] = y + uvY * w2 + (qz * uvX - qx * uvZ) * 2;\n      newDst[2] = z + uvZ * w2 + (qx * uvY - qy * uvX) * 2;\n      return newDst;\n    }\n    function getTranslation(m, dst) {\n      const newDst = dst ?? new Ctor(3);\n      newDst[0] = m[12];\n      newDst[1] = m[13];\n      newDst[2] = m[14];\n      return newDst;\n    }\n    function getAxis(m, axis, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const off = axis * 4;\n      newDst[0] = m[off + 0];\n      newDst[1] = m[off + 1];\n      newDst[2] = m[off + 2];\n      return newDst;\n    }\n    function getScaling(m, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const xx = m[0];\n      const xy = m[1];\n      const xz = m[2];\n      const yx = m[4];\n      const yy = m[5];\n      const yz = m[6];\n      const zx = m[8];\n      const zy = m[9];\n      const zz = m[10];\n      newDst[0] = Math.sqrt(xx * xx + xy * xy + xz * xz);\n      newDst[1] = Math.sqrt(yx * yx + yy * yy + yz * yz);\n      newDst[2] = Math.sqrt(zx * zx + zy * zy + zz * zz);\n      return newDst;\n    }\n    function rotateX(a, b, rad, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const p = [];\n      const r = [];\n      p[0] = a[0] - b[0];\n      p[1] = a[1] - b[1];\n      p[2] = a[2] - b[2];\n      r[0] = p[0];\n      r[1] = p[1] * Math.cos(rad) - p[2] * Math.sin(rad);\n      r[2] = p[1] * Math.sin(rad) + p[2] * Math.cos(rad);\n      newDst[0] = r[0] + b[0];\n      newDst[1] = r[1] + b[1];\n      newDst[2] = r[2] + b[2];\n      return newDst;\n    }\n    function rotateY(a, b, rad, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const p = [];\n      const r = [];\n      p[0] = a[0] - b[0];\n      p[1] = a[1] - b[1];\n      p[2] = a[2] - b[2];\n      r[0] = p[2] * Math.sin(rad) + p[0] * Math.cos(rad);\n      r[1] = p[1];\n      r[2] = p[2] * Math.cos(rad) - p[0] * Math.sin(rad);\n      newDst[0] = r[0] + b[0];\n      newDst[1] = r[1] + b[1];\n      newDst[2] = r[2] + b[2];\n      return newDst;\n    }\n    function rotateZ(a, b, rad, dst) {\n      const newDst = dst ?? new Ctor(3);\n      const p = [];\n      const r = [];\n      p[0] = a[0] - b[0];\n      p[1] = a[1] - b[1];\n      p[2] = a[2] - b[2];\n      r[0] = p[0] * Math.cos(rad) - p[1] * Math.sin(rad);\n      r[1] = p[0] * Math.sin(rad) + p[1] * Math.cos(rad);\n      r[2] = p[2];\n      newDst[0] = r[0] + b[0];\n      newDst[1] = r[1] + b[1];\n      newDst[2] = r[2] + b[2];\n      return newDst;\n    }\n    function setLength(a, len2, dst) {\n      const newDst = dst ?? new Ctor(3);\n      normalize(a, newDst);\n      return mulScalar(newDst, len2, newDst);\n    }\n    function truncate(a, maxLen, dst) {\n      const newDst = dst ?? new Ctor(3);\n      if (length(a) > maxLen) {\n        return setLength(a, maxLen, newDst);\n      }\n      return copy(a, newDst);\n    }\n    function midpoint(a, b, dst) {\n      const newDst = dst ?? new Ctor(3);\n      return lerp(a, b, 0.5, newDst);\n    }\n    return {\n      create,\n      fromValues,\n      set,\n      ceil,\n      floor,\n      round,\n      clamp,\n      add,\n      addScaled,\n      angle,\n      subtract,\n      sub,\n      equalsApproximately,\n      equals,\n      lerp,\n      lerpV,\n      max,\n      min,\n      mulScalar,\n      scale,\n      divScalar,\n      inverse,\n      invert,\n      cross,\n      dot,\n      length,\n      len,\n      lengthSq,\n      lenSq,\n      distance,\n      dist,\n      distanceSq,\n      distSq,\n      normalize,\n      negate,\n      copy,\n      clone,\n      multiply,\n      mul,\n      divide,\n      div,\n      random,\n      zero,\n      transformMat4,\n      transformMat4Upper3x3,\n      transformMat3,\n      transformQuat,\n      getTranslation,\n      getAxis,\n      getScaling,\n      rotateX,\n      rotateY,\n      rotateZ,\n      setLength,\n      truncate,\n      midpoint\n    };\n  }\n  var cache$3 = /* @__PURE__ */ new Map();\n  function getAPI$3(Ctor) {\n    let api = cache$3.get(Ctor);\n    if (!api) {\n      api = getAPIImpl$3(Ctor);\n      cache$3.set(Ctor, api);\n    }\n    return api;\n  }\n  function getAPIImpl$2(Ctor) {\n    const vec32 = getAPI$3(Ctor);\n    function create(v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15) {\n      const newDst = new Ctor(16);\n      if (v0 !== void 0) {\n        newDst[0] = v0;\n        if (v1 !== void 0) {\n          newDst[1] = v1;\n          if (v2 !== void 0) {\n            newDst[2] = v2;\n            if (v3 !== void 0) {\n              newDst[3] = v3;\n              if (v4 !== void 0) {\n                newDst[4] = v4;\n                if (v5 !== void 0) {\n                  newDst[5] = v5;\n                  if (v6 !== void 0) {\n                    newDst[6] = v6;\n                    if (v7 !== void 0) {\n                      newDst[7] = v7;\n                      if (v8 !== void 0) {\n                        newDst[8] = v8;\n                        if (v9 !== void 0) {\n                          newDst[9] = v9;\n                          if (v10 !== void 0) {\n                            newDst[10] = v10;\n                            if (v11 !== void 0) {\n                              newDst[11] = v11;\n                              if (v12 !== void 0) {\n                                newDst[12] = v12;\n                                if (v13 !== void 0) {\n                                  newDst[13] = v13;\n                                  if (v14 !== void 0) {\n                                    newDst[14] = v14;\n                                    if (v15 !== void 0) {\n                                      newDst[15] = v15;\n                                    }\n                                  }\n                                }\n                              }\n                            }\n                          }\n                        }\n                      }\n                    }\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n      return newDst;\n    }\n    function set(v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = v0;\n      newDst[1] = v1;\n      newDst[2] = v2;\n      newDst[3] = v3;\n      newDst[4] = v4;\n      newDst[5] = v5;\n      newDst[6] = v6;\n      newDst[7] = v7;\n      newDst[8] = v8;\n      newDst[9] = v9;\n      newDst[10] = v10;\n      newDst[11] = v11;\n      newDst[12] = v12;\n      newDst[13] = v13;\n      newDst[14] = v14;\n      newDst[15] = v15;\n      return newDst;\n    }\n    function fromMat3(m3, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = m3[0];\n      newDst[1] = m3[1];\n      newDst[2] = m3[2];\n      newDst[3] = 0;\n      newDst[4] = m3[4];\n      newDst[5] = m3[5];\n      newDst[6] = m3[6];\n      newDst[7] = 0;\n      newDst[8] = m3[8];\n      newDst[9] = m3[9];\n      newDst[10] = m3[10];\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function fromQuat(q, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const x = q[0];\n      const y = q[1];\n      const z = q[2];\n      const w = q[3];\n      const x2 = x + x;\n      const y2 = y + y;\n      const z2 = z + z;\n      const xx = x * x2;\n      const yx = y * x2;\n      const yy = y * y2;\n      const zx = z * x2;\n      const zy = z * y2;\n      const zz = z * z2;\n      const wx = w * x2;\n      const wy = w * y2;\n      const wz = w * z2;\n      newDst[0] = 1 - yy - zz;\n      newDst[1] = yx + wz;\n      newDst[2] = zx - wy;\n      newDst[3] = 0;\n      newDst[4] = yx - wz;\n      newDst[5] = 1 - xx - zz;\n      newDst[6] = zy + wx;\n      newDst[7] = 0;\n      newDst[8] = zx + wy;\n      newDst[9] = zy - wx;\n      newDst[10] = 1 - xx - yy;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function negate(m, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = -m[0];\n      newDst[1] = -m[1];\n      newDst[2] = -m[2];\n      newDst[3] = -m[3];\n      newDst[4] = -m[4];\n      newDst[5] = -m[5];\n      newDst[6] = -m[6];\n      newDst[7] = -m[7];\n      newDst[8] = -m[8];\n      newDst[9] = -m[9];\n      newDst[10] = -m[10];\n      newDst[11] = -m[11];\n      newDst[12] = -m[12];\n      newDst[13] = -m[13];\n      newDst[14] = -m[14];\n      newDst[15] = -m[15];\n      return newDst;\n    }\n    function copy(m, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = m[0];\n      newDst[1] = m[1];\n      newDst[2] = m[2];\n      newDst[3] = m[3];\n      newDst[4] = m[4];\n      newDst[5] = m[5];\n      newDst[6] = m[6];\n      newDst[7] = m[7];\n      newDst[8] = m[8];\n      newDst[9] = m[9];\n      newDst[10] = m[10];\n      newDst[11] = m[11];\n      newDst[12] = m[12];\n      newDst[13] = m[13];\n      newDst[14] = m[14];\n      newDst[15] = m[15];\n      return newDst;\n    }\n    const clone = copy;\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[3] - b[3]) < EPSILON && Math.abs(a[4] - b[4]) < EPSILON && Math.abs(a[5] - b[5]) < EPSILON && Math.abs(a[6] - b[6]) < EPSILON && Math.abs(a[7] - b[7]) < EPSILON && Math.abs(a[8] - b[8]) < EPSILON && Math.abs(a[9] - b[9]) < EPSILON && Math.abs(a[10] - b[10]) < EPSILON && Math.abs(a[11] - b[11]) < EPSILON && Math.abs(a[12] - b[12]) < EPSILON && Math.abs(a[13] - b[13]) < EPSILON && Math.abs(a[14] - b[14]) < EPSILON && Math.abs(a[15] - b[15]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5] && a[6] === b[6] && a[7] === b[7] && a[8] === b[8] && a[9] === b[9] && a[10] === b[10] && a[11] === b[11] && a[12] === b[12] && a[13] === b[13] && a[14] === b[14] && a[15] === b[15];\n    }\n    function identity(dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = 1;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 1;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function transpose(m, dst) {\n      const newDst = dst ?? new Ctor(16);\n      if (newDst === m) {\n        let t;\n        t = m[1];\n        m[1] = m[4];\n        m[4] = t;\n        t = m[2];\n        m[2] = m[8];\n        m[8] = t;\n        t = m[3];\n        m[3] = m[12];\n        m[12] = t;\n        t = m[6];\n        m[6] = m[9];\n        m[9] = t;\n        t = m[7];\n        m[7] = m[13];\n        m[13] = t;\n        t = m[11];\n        m[11] = m[14];\n        m[14] = t;\n        return newDst;\n      }\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m03 = m[0 * 4 + 3];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m13 = m[1 * 4 + 3];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const m23 = m[2 * 4 + 3];\n      const m30 = m[3 * 4 + 0];\n      const m31 = m[3 * 4 + 1];\n      const m32 = m[3 * 4 + 2];\n      const m33 = m[3 * 4 + 3];\n      newDst[0] = m00;\n      newDst[1] = m10;\n      newDst[2] = m20;\n      newDst[3] = m30;\n      newDst[4] = m01;\n      newDst[5] = m11;\n      newDst[6] = m21;\n      newDst[7] = m31;\n      newDst[8] = m02;\n      newDst[9] = m12;\n      newDst[10] = m22;\n      newDst[11] = m32;\n      newDst[12] = m03;\n      newDst[13] = m13;\n      newDst[14] = m23;\n      newDst[15] = m33;\n      return newDst;\n    }\n    function inverse(m, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m03 = m[0 * 4 + 3];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m13 = m[1 * 4 + 3];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const m23 = m[2 * 4 + 3];\n      const m30 = m[3 * 4 + 0];\n      const m31 = m[3 * 4 + 1];\n      const m32 = m[3 * 4 + 2];\n      const m33 = m[3 * 4 + 3];\n      const tmp0 = m22 * m33;\n      const tmp1 = m32 * m23;\n      const tmp2 = m12 * m33;\n      const tmp3 = m32 * m13;\n      const tmp4 = m12 * m23;\n      const tmp5 = m22 * m13;\n      const tmp6 = m02 * m33;\n      const tmp7 = m32 * m03;\n      const tmp8 = m02 * m23;\n      const tmp9 = m22 * m03;\n      const tmp10 = m02 * m13;\n      const tmp11 = m12 * m03;\n      const tmp12 = m20 * m31;\n      const tmp13 = m30 * m21;\n      const tmp14 = m10 * m31;\n      const tmp15 = m30 * m11;\n      const tmp16 = m10 * m21;\n      const tmp17 = m20 * m11;\n      const tmp18 = m00 * m31;\n      const tmp19 = m30 * m01;\n      const tmp20 = m00 * m21;\n      const tmp21 = m20 * m01;\n      const tmp22 = m00 * m11;\n      const tmp23 = m10 * m01;\n      const t0 = tmp0 * m11 + tmp3 * m21 + tmp4 * m31 - (tmp1 * m11 + tmp2 * m21 + tmp5 * m31);\n      const t1 = tmp1 * m01 + tmp6 * m21 + tmp9 * m31 - (tmp0 * m01 + tmp7 * m21 + tmp8 * m31);\n      const t2 = tmp2 * m01 + tmp7 * m11 + tmp10 * m31 - (tmp3 * m01 + tmp6 * m11 + tmp11 * m31);\n      const t3 = tmp5 * m01 + tmp8 * m11 + tmp11 * m21 - (tmp4 * m01 + tmp9 * m11 + tmp10 * m21);\n      const d = 1 / (m00 * t0 + m10 * t1 + m20 * t2 + m30 * t3);\n      newDst[0] = d * t0;\n      newDst[1] = d * t1;\n      newDst[2] = d * t2;\n      newDst[3] = d * t3;\n      newDst[4] = d * (tmp1 * m10 + tmp2 * m20 + tmp5 * m30 - (tmp0 * m10 + tmp3 * m20 + tmp4 * m30));\n      newDst[5] = d * (tmp0 * m00 + tmp7 * m20 + tmp8 * m30 - (tmp1 * m00 + tmp6 * m20 + tmp9 * m30));\n      newDst[6] = d * (tmp3 * m00 + tmp6 * m10 + tmp11 * m30 - (tmp2 * m00 + tmp7 * m10 + tmp10 * m30));\n      newDst[7] = d * (tmp4 * m00 + tmp9 * m10 + tmp10 * m20 - (tmp5 * m00 + tmp8 * m10 + tmp11 * m20));\n      newDst[8] = d * (tmp12 * m13 + tmp15 * m23 + tmp16 * m33 - (tmp13 * m13 + tmp14 * m23 + tmp17 * m33));\n      newDst[9] = d * (tmp13 * m03 + tmp18 * m23 + tmp21 * m33 - (tmp12 * m03 + tmp19 * m23 + tmp20 * m33));\n      newDst[10] = d * (tmp14 * m03 + tmp19 * m13 + tmp22 * m33 - (tmp15 * m03 + tmp18 * m13 + tmp23 * m33));\n      newDst[11] = d * (tmp17 * m03 + tmp20 * m13 + tmp23 * m23 - (tmp16 * m03 + tmp21 * m13 + tmp22 * m23));\n      newDst[12] = d * (tmp14 * m22 + tmp17 * m32 + tmp13 * m12 - (tmp16 * m32 + tmp12 * m12 + tmp15 * m22));\n      newDst[13] = d * (tmp20 * m32 + tmp12 * m02 + tmp19 * m22 - (tmp18 * m22 + tmp21 * m32 + tmp13 * m02));\n      newDst[14] = d * (tmp18 * m12 + tmp23 * m32 + tmp15 * m02 - (tmp22 * m32 + tmp14 * m02 + tmp19 * m12));\n      newDst[15] = d * (tmp22 * m22 + tmp16 * m02 + tmp21 * m12 - (tmp20 * m12 + tmp23 * m22 + tmp17 * m02));\n      return newDst;\n    }\n    function determinant(m) {\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m03 = m[0 * 4 + 3];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m13 = m[1 * 4 + 3];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const m23 = m[2 * 4 + 3];\n      const m30 = m[3 * 4 + 0];\n      const m31 = m[3 * 4 + 1];\n      const m32 = m[3 * 4 + 2];\n      const m33 = m[3 * 4 + 3];\n      const tmp0 = m22 * m33;\n      const tmp1 = m32 * m23;\n      const tmp2 = m12 * m33;\n      const tmp3 = m32 * m13;\n      const tmp4 = m12 * m23;\n      const tmp5 = m22 * m13;\n      const tmp6 = m02 * m33;\n      const tmp7 = m32 * m03;\n      const tmp8 = m02 * m23;\n      const tmp9 = m22 * m03;\n      const tmp10 = m02 * m13;\n      const tmp11 = m12 * m03;\n      const t0 = tmp0 * m11 + tmp3 * m21 + tmp4 * m31 - (tmp1 * m11 + tmp2 * m21 + tmp5 * m31);\n      const t1 = tmp1 * m01 + tmp6 * m21 + tmp9 * m31 - (tmp0 * m01 + tmp7 * m21 + tmp8 * m31);\n      const t2 = tmp2 * m01 + tmp7 * m11 + tmp10 * m31 - (tmp3 * m01 + tmp6 * m11 + tmp11 * m31);\n      const t3 = tmp5 * m01 + tmp8 * m11 + tmp11 * m21 - (tmp4 * m01 + tmp9 * m11 + tmp10 * m21);\n      return m00 * t0 + m10 * t1 + m20 * t2 + m30 * t3;\n    }\n    const invert = inverse;\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const a00 = a[0];\n      const a01 = a[1];\n      const a02 = a[2];\n      const a03 = a[3];\n      const a10 = a[4 + 0];\n      const a11 = a[4 + 1];\n      const a12 = a[4 + 2];\n      const a13 = a[4 + 3];\n      const a20 = a[8 + 0];\n      const a21 = a[8 + 1];\n      const a22 = a[8 + 2];\n      const a23 = a[8 + 3];\n      const a30 = a[12 + 0];\n      const a31 = a[12 + 1];\n      const a32 = a[12 + 2];\n      const a33 = a[12 + 3];\n      const b00 = b[0];\n      const b01 = b[1];\n      const b02 = b[2];\n      const b03 = b[3];\n      const b10 = b[4 + 0];\n      const b11 = b[4 + 1];\n      const b12 = b[4 + 2];\n      const b13 = b[4 + 3];\n      const b20 = b[8 + 0];\n      const b21 = b[8 + 1];\n      const b22 = b[8 + 2];\n      const b23 = b[8 + 3];\n      const b30 = b[12 + 0];\n      const b31 = b[12 + 1];\n      const b32 = b[12 + 2];\n      const b33 = b[12 + 3];\n      newDst[0] = a00 * b00 + a10 * b01 + a20 * b02 + a30 * b03;\n      newDst[1] = a01 * b00 + a11 * b01 + a21 * b02 + a31 * b03;\n      newDst[2] = a02 * b00 + a12 * b01 + a22 * b02 + a32 * b03;\n      newDst[3] = a03 * b00 + a13 * b01 + a23 * b02 + a33 * b03;\n      newDst[4] = a00 * b10 + a10 * b11 + a20 * b12 + a30 * b13;\n      newDst[5] = a01 * b10 + a11 * b11 + a21 * b12 + a31 * b13;\n      newDst[6] = a02 * b10 + a12 * b11 + a22 * b12 + a32 * b13;\n      newDst[7] = a03 * b10 + a13 * b11 + a23 * b12 + a33 * b13;\n      newDst[8] = a00 * b20 + a10 * b21 + a20 * b22 + a30 * b23;\n      newDst[9] = a01 * b20 + a11 * b21 + a21 * b22 + a31 * b23;\n      newDst[10] = a02 * b20 + a12 * b21 + a22 * b22 + a32 * b23;\n      newDst[11] = a03 * b20 + a13 * b21 + a23 * b22 + a33 * b23;\n      newDst[12] = a00 * b30 + a10 * b31 + a20 * b32 + a30 * b33;\n      newDst[13] = a01 * b30 + a11 * b31 + a21 * b32 + a31 * b33;\n      newDst[14] = a02 * b30 + a12 * b31 + a22 * b32 + a32 * b33;\n      newDst[15] = a03 * b30 + a13 * b31 + a23 * b32 + a33 * b33;\n      return newDst;\n    }\n    const mul = multiply;\n    function setTranslation(a, v, dst) {\n      const newDst = dst ?? identity();\n      if (a !== newDst) {\n        newDst[0] = a[0];\n        newDst[1] = a[1];\n        newDst[2] = a[2];\n        newDst[3] = a[3];\n        newDst[4] = a[4];\n        newDst[5] = a[5];\n        newDst[6] = a[6];\n        newDst[7] = a[7];\n        newDst[8] = a[8];\n        newDst[9] = a[9];\n        newDst[10] = a[10];\n        newDst[11] = a[11];\n      }\n      newDst[12] = v[0];\n      newDst[13] = v[1];\n      newDst[14] = v[2];\n      newDst[15] = 1;\n      return newDst;\n    }\n    function getTranslation(m, dst) {\n      const newDst = dst ?? vec32.create();\n      newDst[0] = m[12];\n      newDst[1] = m[13];\n      newDst[2] = m[14];\n      return newDst;\n    }\n    function getAxis(m, axis, dst) {\n      const newDst = dst ?? vec32.create();\n      const off = axis * 4;\n      newDst[0] = m[off + 0];\n      newDst[1] = m[off + 1];\n      newDst[2] = m[off + 2];\n      return newDst;\n    }\n    function setAxis(m, v, axis, dst) {\n      const newDst = dst === m ? dst : copy(m, dst);\n      const off = axis * 4;\n      newDst[off + 0] = v[0];\n      newDst[off + 1] = v[1];\n      newDst[off + 2] = v[2];\n      return newDst;\n    }\n    function getScaling(m, dst) {\n      const newDst = dst ?? vec32.create();\n      const xx = m[0];\n      const xy = m[1];\n      const xz = m[2];\n      const yx = m[4];\n      const yy = m[5];\n      const yz = m[6];\n      const zx = m[8];\n      const zy = m[9];\n      const zz = m[10];\n      newDst[0] = Math.sqrt(xx * xx + xy * xy + xz * xz);\n      newDst[1] = Math.sqrt(yx * yx + yy * yy + yz * yz);\n      newDst[2] = Math.sqrt(zx * zx + zy * zy + zz * zz);\n      return newDst;\n    }\n    function perspective(fieldOfViewYInRadians, aspect, zNear, zFar, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const f = Math.tan(Math.PI * 0.5 - 0.5 * fieldOfViewYInRadians);\n      newDst[0] = f / aspect;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = f;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[11] = -1;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[15] = 0;\n      if (Number.isFinite(zFar)) {\n        const rangeInv = 1 / (zNear - zFar);\n        newDst[10] = zFar * rangeInv;\n        newDst[14] = zFar * zNear * rangeInv;\n      } else {\n        newDst[10] = -1;\n        newDst[14] = -zNear;\n      }\n      return newDst;\n    }\n    function perspectiveReverseZ(fieldOfViewYInRadians, aspect, zNear, zFar = Infinity, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const f = 1 / Math.tan(fieldOfViewYInRadians * 0.5);\n      newDst[0] = f / aspect;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = f;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[11] = -1;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[15] = 0;\n      if (zFar === Infinity) {\n        newDst[10] = 0;\n        newDst[14] = zNear;\n      } else {\n        const rangeInv = 1 / (zFar - zNear);\n        newDst[10] = zNear * rangeInv;\n        newDst[14] = zFar * zNear * rangeInv;\n      }\n      return newDst;\n    }\n    function ortho(left, right, bottom, top, near, far, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = 2 / (right - left);\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 2 / (top - bottom);\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1 / (near - far);\n      newDst[11] = 0;\n      newDst[12] = (right + left) / (left - right);\n      newDst[13] = (top + bottom) / (bottom - top);\n      newDst[14] = near / (near - far);\n      newDst[15] = 1;\n      return newDst;\n    }\n    function frustum(left, right, bottom, top, near, far, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const dx = right - left;\n      const dy = top - bottom;\n      const dz = near - far;\n      newDst[0] = 2 * near / dx;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 2 * near / dy;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = (left + right) / dx;\n      newDst[9] = (top + bottom) / dy;\n      newDst[10] = far / dz;\n      newDst[11] = -1;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = near * far / dz;\n      newDst[15] = 0;\n      return newDst;\n    }\n    function frustumReverseZ(left, right, bottom, top, near, far = Infinity, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const dx = right - left;\n      const dy = top - bottom;\n      newDst[0] = 2 * near / dx;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 2 * near / dy;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = (left + right) / dx;\n      newDst[9] = (top + bottom) / dy;\n      newDst[11] = -1;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[15] = 0;\n      if (far === Infinity) {\n        newDst[10] = 0;\n        newDst[14] = near;\n      } else {\n        const rangeInv = 1 / (far - near);\n        newDst[10] = near * rangeInv;\n        newDst[14] = far * near * rangeInv;\n      }\n      return newDst;\n    }\n    const xAxis = vec32.create();\n    const yAxis = vec32.create();\n    const zAxis = vec32.create();\n    function aim(position, target, up, dst) {\n      const newDst = dst ?? new Ctor(16);\n      vec32.normalize(vec32.subtract(target, position, zAxis), zAxis);\n      vec32.normalize(vec32.cross(up, zAxis, xAxis), xAxis);\n      vec32.normalize(vec32.cross(zAxis, xAxis, yAxis), yAxis);\n      newDst[0] = xAxis[0];\n      newDst[1] = xAxis[1];\n      newDst[2] = xAxis[2];\n      newDst[3] = 0;\n      newDst[4] = yAxis[0];\n      newDst[5] = yAxis[1];\n      newDst[6] = yAxis[2];\n      newDst[7] = 0;\n      newDst[8] = zAxis[0];\n      newDst[9] = zAxis[1];\n      newDst[10] = zAxis[2];\n      newDst[11] = 0;\n      newDst[12] = position[0];\n      newDst[13] = position[1];\n      newDst[14] = position[2];\n      newDst[15] = 1;\n      return newDst;\n    }\n    function cameraAim(eye, target, up, dst) {\n      const newDst = dst ?? new Ctor(16);\n      vec32.normalize(vec32.subtract(eye, target, zAxis), zAxis);\n      vec32.normalize(vec32.cross(up, zAxis, xAxis), xAxis);\n      vec32.normalize(vec32.cross(zAxis, xAxis, yAxis), yAxis);\n      newDst[0] = xAxis[0];\n      newDst[1] = xAxis[1];\n      newDst[2] = xAxis[2];\n      newDst[3] = 0;\n      newDst[4] = yAxis[0];\n      newDst[5] = yAxis[1];\n      newDst[6] = yAxis[2];\n      newDst[7] = 0;\n      newDst[8] = zAxis[0];\n      newDst[9] = zAxis[1];\n      newDst[10] = zAxis[2];\n      newDst[11] = 0;\n      newDst[12] = eye[0];\n      newDst[13] = eye[1];\n      newDst[14] = eye[2];\n      newDst[15] = 1;\n      return newDst;\n    }\n    function lookAt(eye, target, up, dst) {\n      const newDst = dst ?? new Ctor(16);\n      vec32.normalize(vec32.subtract(eye, target, zAxis), zAxis);\n      vec32.normalize(vec32.cross(up, zAxis, xAxis), xAxis);\n      vec32.normalize(vec32.cross(zAxis, xAxis, yAxis), yAxis);\n      newDst[0] = xAxis[0];\n      newDst[1] = yAxis[0];\n      newDst[2] = zAxis[0];\n      newDst[3] = 0;\n      newDst[4] = xAxis[1];\n      newDst[5] = yAxis[1];\n      newDst[6] = zAxis[1];\n      newDst[7] = 0;\n      newDst[8] = xAxis[2];\n      newDst[9] = yAxis[2];\n      newDst[10] = zAxis[2];\n      newDst[11] = 0;\n      newDst[12] = -(xAxis[0] * eye[0] + xAxis[1] * eye[1] + xAxis[2] * eye[2]);\n      newDst[13] = -(yAxis[0] * eye[0] + yAxis[1] * eye[1] + yAxis[2] * eye[2]);\n      newDst[14] = -(zAxis[0] * eye[0] + zAxis[1] * eye[1] + zAxis[2] * eye[2]);\n      newDst[15] = 1;\n      return newDst;\n    }\n    function translation(v, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = 1;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 1;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      newDst[11] = 0;\n      newDst[12] = v[0];\n      newDst[13] = v[1];\n      newDst[14] = v[2];\n      newDst[15] = 1;\n      return newDst;\n    }\n    function translate(m, v, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const m00 = m[0];\n      const m01 = m[1];\n      const m02 = m[2];\n      const m03 = m[3];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m13 = m[1 * 4 + 3];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const m23 = m[2 * 4 + 3];\n      const m30 = m[3 * 4 + 0];\n      const m31 = m[3 * 4 + 1];\n      const m32 = m[3 * 4 + 2];\n      const m33 = m[3 * 4 + 3];\n      if (m !== newDst) {\n        newDst[0] = m00;\n        newDst[1] = m01;\n        newDst[2] = m02;\n        newDst[3] = m03;\n        newDst[4] = m10;\n        newDst[5] = m11;\n        newDst[6] = m12;\n        newDst[7] = m13;\n        newDst[8] = m20;\n        newDst[9] = m21;\n        newDst[10] = m22;\n        newDst[11] = m23;\n      }\n      newDst[12] = m00 * v0 + m10 * v1 + m20 * v2 + m30;\n      newDst[13] = m01 * v0 + m11 * v1 + m21 * v2 + m31;\n      newDst[14] = m02 * v0 + m12 * v1 + m22 * v2 + m32;\n      newDst[15] = m03 * v0 + m13 * v1 + m23 * v2 + m33;\n      return newDst;\n    }\n    function rotationX(angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = 1;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = c;\n      newDst[6] = s;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = -s;\n      newDst[10] = c;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function rotateX(m, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const m10 = m[4];\n      const m11 = m[5];\n      const m12 = m[6];\n      const m13 = m[7];\n      const m20 = m[8];\n      const m21 = m[9];\n      const m22 = m[10];\n      const m23 = m[11];\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[4] = c * m10 + s * m20;\n      newDst[5] = c * m11 + s * m21;\n      newDst[6] = c * m12 + s * m22;\n      newDst[7] = c * m13 + s * m23;\n      newDst[8] = c * m20 - s * m10;\n      newDst[9] = c * m21 - s * m11;\n      newDst[10] = c * m22 - s * m12;\n      newDst[11] = c * m23 - s * m13;\n      if (m !== newDst) {\n        newDst[0] = m[0];\n        newDst[1] = m[1];\n        newDst[2] = m[2];\n        newDst[3] = m[3];\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    function rotationY(angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c;\n      newDst[1] = 0;\n      newDst[2] = -s;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = 1;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = s;\n      newDst[9] = 0;\n      newDst[10] = c;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function rotateY(m, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m03 = m[0 * 4 + 3];\n      const m20 = m[2 * 4 + 0];\n      const m21 = m[2 * 4 + 1];\n      const m22 = m[2 * 4 + 2];\n      const m23 = m[2 * 4 + 3];\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c * m00 - s * m20;\n      newDst[1] = c * m01 - s * m21;\n      newDst[2] = c * m02 - s * m22;\n      newDst[3] = c * m03 - s * m23;\n      newDst[8] = c * m20 + s * m00;\n      newDst[9] = c * m21 + s * m01;\n      newDst[10] = c * m22 + s * m02;\n      newDst[11] = c * m23 + s * m03;\n      if (m !== newDst) {\n        newDst[4] = m[4];\n        newDst[5] = m[5];\n        newDst[6] = m[6];\n        newDst[7] = m[7];\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    function rotationZ(angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c;\n      newDst[1] = s;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = -s;\n      newDst[5] = c;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = 1;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function rotateZ(m, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const m00 = m[0 * 4 + 0];\n      const m01 = m[0 * 4 + 1];\n      const m02 = m[0 * 4 + 2];\n      const m03 = m[0 * 4 + 3];\n      const m10 = m[1 * 4 + 0];\n      const m11 = m[1 * 4 + 1];\n      const m12 = m[1 * 4 + 2];\n      const m13 = m[1 * 4 + 3];\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      newDst[0] = c * m00 + s * m10;\n      newDst[1] = c * m01 + s * m11;\n      newDst[2] = c * m02 + s * m12;\n      newDst[3] = c * m03 + s * m13;\n      newDst[4] = c * m10 - s * m00;\n      newDst[5] = c * m11 - s * m01;\n      newDst[6] = c * m12 - s * m02;\n      newDst[7] = c * m13 - s * m03;\n      if (m !== newDst) {\n        newDst[8] = m[8];\n        newDst[9] = m[9];\n        newDst[10] = m[10];\n        newDst[11] = m[11];\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    function axisRotation(axis, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      let x = axis[0];\n      let y = axis[1];\n      let z = axis[2];\n      const n = Math.sqrt(x * x + y * y + z * z);\n      x /= n;\n      y /= n;\n      z /= n;\n      const xx = x * x;\n      const yy = y * y;\n      const zz = z * z;\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      const oneMinusCosine = 1 - c;\n      newDst[0] = xx + (1 - xx) * c;\n      newDst[1] = x * y * oneMinusCosine + z * s;\n      newDst[2] = x * z * oneMinusCosine - y * s;\n      newDst[3] = 0;\n      newDst[4] = x * y * oneMinusCosine - z * s;\n      newDst[5] = yy + (1 - yy) * c;\n      newDst[6] = y * z * oneMinusCosine + x * s;\n      newDst[7] = 0;\n      newDst[8] = x * z * oneMinusCosine + y * s;\n      newDst[9] = y * z * oneMinusCosine - x * s;\n      newDst[10] = zz + (1 - zz) * c;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    const rotation = axisRotation;\n    function axisRotate(m, axis, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(16);\n      let x = axis[0];\n      let y = axis[1];\n      let z = axis[2];\n      const n = Math.sqrt(x * x + y * y + z * z);\n      x /= n;\n      y /= n;\n      z /= n;\n      const xx = x * x;\n      const yy = y * y;\n      const zz = z * z;\n      const c = Math.cos(angleInRadians);\n      const s = Math.sin(angleInRadians);\n      const oneMinusCosine = 1 - c;\n      const r00 = xx + (1 - xx) * c;\n      const r01 = x * y * oneMinusCosine + z * s;\n      const r02 = x * z * oneMinusCosine - y * s;\n      const r10 = x * y * oneMinusCosine - z * s;\n      const r11 = yy + (1 - yy) * c;\n      const r12 = y * z * oneMinusCosine + x * s;\n      const r20 = x * z * oneMinusCosine + y * s;\n      const r21 = y * z * oneMinusCosine - x * s;\n      const r22 = zz + (1 - zz) * c;\n      const m00 = m[0];\n      const m01 = m[1];\n      const m02 = m[2];\n      const m03 = m[3];\n      const m10 = m[4];\n      const m11 = m[5];\n      const m12 = m[6];\n      const m13 = m[7];\n      const m20 = m[8];\n      const m21 = m[9];\n      const m22 = m[10];\n      const m23 = m[11];\n      newDst[0] = r00 * m00 + r01 * m10 + r02 * m20;\n      newDst[1] = r00 * m01 + r01 * m11 + r02 * m21;\n      newDst[2] = r00 * m02 + r01 * m12 + r02 * m22;\n      newDst[3] = r00 * m03 + r01 * m13 + r02 * m23;\n      newDst[4] = r10 * m00 + r11 * m10 + r12 * m20;\n      newDst[5] = r10 * m01 + r11 * m11 + r12 * m21;\n      newDst[6] = r10 * m02 + r11 * m12 + r12 * m22;\n      newDst[7] = r10 * m03 + r11 * m13 + r12 * m23;\n      newDst[8] = r20 * m00 + r21 * m10 + r22 * m20;\n      newDst[9] = r20 * m01 + r21 * m11 + r22 * m21;\n      newDst[10] = r20 * m02 + r21 * m12 + r22 * m22;\n      newDst[11] = r20 * m03 + r21 * m13 + r22 * m23;\n      if (m !== newDst) {\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    const rotate = axisRotate;\n    function scaling(v, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = v[0];\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = v[1];\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = v[2];\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function scale(m, v, dst) {\n      const newDst = dst ?? new Ctor(16);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      newDst[0] = v0 * m[0 * 4 + 0];\n      newDst[1] = v0 * m[0 * 4 + 1];\n      newDst[2] = v0 * m[0 * 4 + 2];\n      newDst[3] = v0 * m[0 * 4 + 3];\n      newDst[4] = v1 * m[1 * 4 + 0];\n      newDst[5] = v1 * m[1 * 4 + 1];\n      newDst[6] = v1 * m[1 * 4 + 2];\n      newDst[7] = v1 * m[1 * 4 + 3];\n      newDst[8] = v2 * m[2 * 4 + 0];\n      newDst[9] = v2 * m[2 * 4 + 1];\n      newDst[10] = v2 * m[2 * 4 + 2];\n      newDst[11] = v2 * m[2 * 4 + 3];\n      if (m !== newDst) {\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    function uniformScaling(s, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = s;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      newDst[4] = 0;\n      newDst[5] = s;\n      newDst[6] = 0;\n      newDst[7] = 0;\n      newDst[8] = 0;\n      newDst[9] = 0;\n      newDst[10] = s;\n      newDst[11] = 0;\n      newDst[12] = 0;\n      newDst[13] = 0;\n      newDst[14] = 0;\n      newDst[15] = 1;\n      return newDst;\n    }\n    function uniformScale(m, s, dst) {\n      const newDst = dst ?? new Ctor(16);\n      newDst[0] = s * m[0 * 4 + 0];\n      newDst[1] = s * m[0 * 4 + 1];\n      newDst[2] = s * m[0 * 4 + 2];\n      newDst[3] = s * m[0 * 4 + 3];\n      newDst[4] = s * m[1 * 4 + 0];\n      newDst[5] = s * m[1 * 4 + 1];\n      newDst[6] = s * m[1 * 4 + 2];\n      newDst[7] = s * m[1 * 4 + 3];\n      newDst[8] = s * m[2 * 4 + 0];\n      newDst[9] = s * m[2 * 4 + 1];\n      newDst[10] = s * m[2 * 4 + 2];\n      newDst[11] = s * m[2 * 4 + 3];\n      if (m !== newDst) {\n        newDst[12] = m[12];\n        newDst[13] = m[13];\n        newDst[14] = m[14];\n        newDst[15] = m[15];\n      }\n      return newDst;\n    }\n    return {\n      create,\n      set,\n      fromMat3,\n      fromQuat,\n      negate,\n      copy,\n      clone,\n      equalsApproximately,\n      equals,\n      identity,\n      transpose,\n      inverse,\n      determinant,\n      invert,\n      multiply,\n      mul,\n      setTranslation,\n      getTranslation,\n      getAxis,\n      setAxis,\n      getScaling,\n      perspective,\n      perspectiveReverseZ,\n      ortho,\n      frustum,\n      frustumReverseZ,\n      aim,\n      cameraAim,\n      lookAt,\n      translation,\n      translate,\n      rotationX,\n      rotateX,\n      rotationY,\n      rotateY,\n      rotationZ,\n      rotateZ,\n      axisRotation,\n      rotation,\n      axisRotate,\n      rotate,\n      scaling,\n      scale,\n      uniformScaling,\n      uniformScale\n    };\n  }\n  var cache$2 = /* @__PURE__ */ new Map();\n  function getAPI$2(Ctor) {\n    let api = cache$2.get(Ctor);\n    if (!api) {\n      api = getAPIImpl$2(Ctor);\n      cache$2.set(Ctor, api);\n    }\n    return api;\n  }\n  function getAPIImpl$1(Ctor) {\n    const vec32 = getAPI$3(Ctor);\n    function create(x, y, z, w) {\n      const newDst = new Ctor(4);\n      if (x !== void 0) {\n        newDst[0] = x;\n        if (y !== void 0) {\n          newDst[1] = y;\n          if (z !== void 0) {\n            newDst[2] = z;\n            if (w !== void 0) {\n              newDst[3] = w;\n            }\n          }\n        }\n      }\n      return newDst;\n    }\n    const fromValues = create;\n    function set(x, y, z, w, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = x;\n      newDst[1] = y;\n      newDst[2] = z;\n      newDst[3] = w;\n      return newDst;\n    }\n    function fromAxisAngle(axis, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const halfAngle = angleInRadians * 0.5;\n      const s = Math.sin(halfAngle);\n      newDst[0] = s * axis[0];\n      newDst[1] = s * axis[1];\n      newDst[2] = s * axis[2];\n      newDst[3] = Math.cos(halfAngle);\n      return newDst;\n    }\n    function toAxisAngle(q, dst) {\n      const newDst = dst ?? vec32.create(3);\n      const angle2 = Math.acos(q[3]) * 2;\n      const s = Math.sin(angle2 * 0.5);\n      if (s > EPSILON) {\n        newDst[0] = q[0] / s;\n        newDst[1] = q[1] / s;\n        newDst[2] = q[2] / s;\n      } else {\n        newDst[0] = 1;\n        newDst[1] = 0;\n        newDst[2] = 0;\n      }\n      return { angle: angle2, axis: newDst };\n    }\n    function angle(a, b) {\n      const d = dot(a, b);\n      return Math.acos(2 * d * d - 1);\n    }\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const ax = a[0];\n      const ay = a[1];\n      const az = a[2];\n      const aw = a[3];\n      const bx = b[0];\n      const by = b[1];\n      const bz = b[2];\n      const bw = b[3];\n      newDst[0] = ax * bw + aw * bx + ay * bz - az * by;\n      newDst[1] = ay * bw + aw * by + az * bx - ax * bz;\n      newDst[2] = az * bw + aw * bz + ax * by - ay * bx;\n      newDst[3] = aw * bw - ax * bx - ay * by - az * bz;\n      return newDst;\n    }\n    const mul = multiply;\n    function rotateX(q, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const halfAngle = angleInRadians * 0.5;\n      const qx = q[0];\n      const qy = q[1];\n      const qz = q[2];\n      const qw = q[3];\n      const bx = Math.sin(halfAngle);\n      const bw = Math.cos(halfAngle);\n      newDst[0] = qx * bw + qw * bx;\n      newDst[1] = qy * bw + qz * bx;\n      newDst[2] = qz * bw - qy * bx;\n      newDst[3] = qw * bw - qx * bx;\n      return newDst;\n    }\n    function rotateY(q, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const halfAngle = angleInRadians * 0.5;\n      const qx = q[0];\n      const qy = q[1];\n      const qz = q[2];\n      const qw = q[3];\n      const by = Math.sin(halfAngle);\n      const bw = Math.cos(halfAngle);\n      newDst[0] = qx * bw - qz * by;\n      newDst[1] = qy * bw + qw * by;\n      newDst[2] = qz * bw + qx * by;\n      newDst[3] = qw * bw - qy * by;\n      return newDst;\n    }\n    function rotateZ(q, angleInRadians, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const halfAngle = angleInRadians * 0.5;\n      const qx = q[0];\n      const qy = q[1];\n      const qz = q[2];\n      const qw = q[3];\n      const bz = Math.sin(halfAngle);\n      const bw = Math.cos(halfAngle);\n      newDst[0] = qx * bw + qy * bz;\n      newDst[1] = qy * bw - qx * bz;\n      newDst[2] = qz * bw + qw * bz;\n      newDst[3] = qw * bw - qz * bz;\n      return newDst;\n    }\n    function slerp(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const ax = a[0];\n      const ay = a[1];\n      const az = a[2];\n      const aw = a[3];\n      let bx = b[0];\n      let by = b[1];\n      let bz = b[2];\n      let bw = b[3];\n      let cosOmega = ax * bx + ay * by + az * bz + aw * bw;\n      if (cosOmega < 0) {\n        cosOmega = -cosOmega;\n        bx = -bx;\n        by = -by;\n        bz = -bz;\n        bw = -bw;\n      }\n      let scale0;\n      let scale1;\n      if (1 - cosOmega > EPSILON) {\n        const omega = Math.acos(cosOmega);\n        const sinOmega = Math.sin(omega);\n        scale0 = Math.sin((1 - t) * omega) / sinOmega;\n        scale1 = Math.sin(t * omega) / sinOmega;\n      } else {\n        scale0 = 1 - t;\n        scale1 = t;\n      }\n      newDst[0] = scale0 * ax + scale1 * bx;\n      newDst[1] = scale0 * ay + scale1 * by;\n      newDst[2] = scale0 * az + scale1 * bz;\n      newDst[3] = scale0 * aw + scale1 * bw;\n      return newDst;\n    }\n    function inverse(q, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const a0 = q[0];\n      const a1 = q[1];\n      const a2 = q[2];\n      const a3 = q[3];\n      const dot2 = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;\n      const invDot = dot2 ? 1 / dot2 : 0;\n      newDst[0] = -a0 * invDot;\n      newDst[1] = -a1 * invDot;\n      newDst[2] = -a2 * invDot;\n      newDst[3] = a3 * invDot;\n      return newDst;\n    }\n    function conjugate(q, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = -q[0];\n      newDst[1] = -q[1];\n      newDst[2] = -q[2];\n      newDst[3] = q[3];\n      return newDst;\n    }\n    function fromMat(m, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const trace = m[0] + m[5] + m[10];\n      if (trace > 0) {\n        const root = Math.sqrt(trace + 1);\n        newDst[3] = 0.5 * root;\n        const invRoot = 0.5 / root;\n        newDst[0] = (m[6] - m[9]) * invRoot;\n        newDst[1] = (m[8] - m[2]) * invRoot;\n        newDst[2] = (m[1] - m[4]) * invRoot;\n      } else {\n        let i = 0;\n        if (m[5] > m[0]) {\n          i = 1;\n        }\n        if (m[10] > m[i * 4 + i]) {\n          i = 2;\n        }\n        const j = (i + 1) % 3;\n        const k = (i + 2) % 3;\n        const root = Math.sqrt(m[i * 4 + i] - m[j * 4 + j] - m[k * 4 + k] + 1);\n        newDst[i] = 0.5 * root;\n        const invRoot = 0.5 / root;\n        newDst[3] = (m[j * 4 + k] - m[k * 4 + j]) * invRoot;\n        newDst[j] = (m[j * 4 + i] + m[i * 4 + j]) * invRoot;\n        newDst[k] = (m[k * 4 + i] + m[i * 4 + k]) * invRoot;\n      }\n      return newDst;\n    }\n    function fromEuler(xAngleInRadians, yAngleInRadians, zAngleInRadians, order, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const xHalfAngle = xAngleInRadians * 0.5;\n      const yHalfAngle = yAngleInRadians * 0.5;\n      const zHalfAngle = zAngleInRadians * 0.5;\n      const sx = Math.sin(xHalfAngle);\n      const cx = Math.cos(xHalfAngle);\n      const sy = Math.sin(yHalfAngle);\n      const cy = Math.cos(yHalfAngle);\n      const sz = Math.sin(zHalfAngle);\n      const cz = Math.cos(zHalfAngle);\n      switch (order) {\n        case "xyz":\n          newDst[0] = sx * cy * cz + cx * sy * sz;\n          newDst[1] = cx * sy * cz - sx * cy * sz;\n          newDst[2] = cx * cy * sz + sx * sy * cz;\n          newDst[3] = cx * cy * cz - sx * sy * sz;\n          break;\n        case "xzy":\n          newDst[0] = sx * cy * cz - cx * sy * sz;\n          newDst[1] = cx * sy * cz - sx * cy * sz;\n          newDst[2] = cx * cy * sz + sx * sy * cz;\n          newDst[3] = cx * cy * cz + sx * sy * sz;\n          break;\n        case "yxz":\n          newDst[0] = sx * cy * cz + cx * sy * sz;\n          newDst[1] = cx * sy * cz - sx * cy * sz;\n          newDst[2] = cx * cy * sz - sx * sy * cz;\n          newDst[3] = cx * cy * cz + sx * sy * sz;\n          break;\n        case "yzx":\n          newDst[0] = sx * cy * cz + cx * sy * sz;\n          newDst[1] = cx * sy * cz + sx * cy * sz;\n          newDst[2] = cx * cy * sz - sx * sy * cz;\n          newDst[3] = cx * cy * cz - sx * sy * sz;\n          break;\n        case "zxy":\n          newDst[0] = sx * cy * cz - cx * sy * sz;\n          newDst[1] = cx * sy * cz + sx * cy * sz;\n          newDst[2] = cx * cy * sz + sx * sy * cz;\n          newDst[3] = cx * cy * cz - sx * sy * sz;\n          break;\n        case "zyx":\n          newDst[0] = sx * cy * cz - cx * sy * sz;\n          newDst[1] = cx * sy * cz + sx * cy * sz;\n          newDst[2] = cx * cy * sz - sx * sy * cz;\n          newDst[3] = cx * cy * cz + sx * sy * sz;\n          break;\n        default:\n          throw new Error(`Unknown rotation order: ${order}`);\n      }\n      return newDst;\n    }\n    function copy(q, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = q[0];\n      newDst[1] = q[1];\n      newDst[2] = q[2];\n      newDst[3] = q[3];\n      return newDst;\n    }\n    const clone = copy;\n    function add(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + b[0];\n      newDst[1] = a[1] + b[1];\n      newDst[2] = a[2] + b[2];\n      newDst[3] = a[3] + b[3];\n      return newDst;\n    }\n    function subtract(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] - b[0];\n      newDst[1] = a[1] - b[1];\n      newDst[2] = a[2] - b[2];\n      newDst[3] = a[3] - b[3];\n      return newDst;\n    }\n    const sub = subtract;\n    function mulScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = v[0] * k;\n      newDst[1] = v[1] * k;\n      newDst[2] = v[2] * k;\n      newDst[3] = v[3] * k;\n      return newDst;\n    }\n    const scale = mulScalar;\n    function divScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = v[0] / k;\n      newDst[1] = v[1] / k;\n      newDst[2] = v[2] / k;\n      newDst[3] = v[3] / k;\n      return newDst;\n    }\n    function dot(a, b) {\n      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];\n    }\n    function lerp(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + t * (b[0] - a[0]);\n      newDst[1] = a[1] + t * (b[1] - a[1]);\n      newDst[2] = a[2] + t * (b[2] - a[2]);\n      newDst[3] = a[3] + t * (b[3] - a[3]);\n      return newDst;\n    }\n    function length(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      return Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);\n    }\n    const len = length;\n    function lengthSq(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      return v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3;\n    }\n    const lenSq = lengthSq;\n    function normalize(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      const len2 = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);\n      if (len2 > 1e-5) {\n        newDst[0] = v0 / len2;\n        newDst[1] = v1 / len2;\n        newDst[2] = v2 / len2;\n        newDst[3] = v3 / len2;\n      } else {\n        newDst[0] = 0;\n        newDst[1] = 0;\n        newDst[2] = 0;\n        newDst[3] = 0;\n      }\n      return newDst;\n    }\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[3] - b[3]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];\n    }\n    function identity(dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = 0;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 1;\n      return newDst;\n    }\n    const tempVec3 = vec32.create();\n    const xUnitVec3 = vec32.create();\n    const yUnitVec3 = vec32.create();\n    function rotationTo(aUnit, bUnit, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const dot2 = vec32.dot(aUnit, bUnit);\n      if (dot2 < -0.999999) {\n        vec32.cross(xUnitVec3, aUnit, tempVec3);\n        if (vec32.len(tempVec3) < 1e-6) {\n          vec32.cross(yUnitVec3, aUnit, tempVec3);\n        }\n        vec32.normalize(tempVec3, tempVec3);\n        fromAxisAngle(tempVec3, Math.PI, newDst);\n        return newDst;\n      } else if (dot2 > 0.999999) {\n        newDst[0] = 0;\n        newDst[1] = 0;\n        newDst[2] = 0;\n        newDst[3] = 1;\n        return newDst;\n      } else {\n        vec32.cross(aUnit, bUnit, tempVec3);\n        newDst[0] = tempVec3[0];\n        newDst[1] = tempVec3[1];\n        newDst[2] = tempVec3[2];\n        newDst[3] = 1 + dot2;\n        return normalize(newDst, newDst);\n      }\n    }\n    const tempQuat1 = new Ctor(4);\n    const tempQuat2 = new Ctor(4);\n    function sqlerp(a, b, c, d, t, dst) {\n      const newDst = dst ?? new Ctor(4);\n      slerp(a, d, t, tempQuat1);\n      slerp(b, c, t, tempQuat2);\n      slerp(tempQuat1, tempQuat2, 2 * t * (1 - t), newDst);\n      return newDst;\n    }\n    return {\n      create,\n      fromValues,\n      set,\n      fromAxisAngle,\n      toAxisAngle,\n      angle,\n      multiply,\n      mul,\n      rotateX,\n      rotateY,\n      rotateZ,\n      slerp,\n      inverse,\n      conjugate,\n      fromMat,\n      fromEuler,\n      copy,\n      clone,\n      add,\n      subtract,\n      sub,\n      mulScalar,\n      scale,\n      divScalar,\n      dot,\n      lerp,\n      length,\n      len,\n      lengthSq,\n      lenSq,\n      normalize,\n      equalsApproximately,\n      equals,\n      identity,\n      rotationTo,\n      sqlerp\n    };\n  }\n  var cache$1 = /* @__PURE__ */ new Map();\n  function getAPI$1(Ctor) {\n    let api = cache$1.get(Ctor);\n    if (!api) {\n      api = getAPIImpl$1(Ctor);\n      cache$1.set(Ctor, api);\n    }\n    return api;\n  }\n  function getAPIImpl(Ctor) {\n    function create(x, y, z, w) {\n      const newDst = new Ctor(4);\n      if (x !== void 0) {\n        newDst[0] = x;\n        if (y !== void 0) {\n          newDst[1] = y;\n          if (z !== void 0) {\n            newDst[2] = z;\n            if (w !== void 0) {\n              newDst[3] = w;\n            }\n          }\n        }\n      }\n      return newDst;\n    }\n    const fromValues = create;\n    function set(x, y, z, w, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = x;\n      newDst[1] = y;\n      newDst[2] = z;\n      newDst[3] = w;\n      return newDst;\n    }\n    function ceil(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.ceil(v[0]);\n      newDst[1] = Math.ceil(v[1]);\n      newDst[2] = Math.ceil(v[2]);\n      newDst[3] = Math.ceil(v[3]);\n      return newDst;\n    }\n    function floor(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.floor(v[0]);\n      newDst[1] = Math.floor(v[1]);\n      newDst[2] = Math.floor(v[2]);\n      newDst[3] = Math.floor(v[3]);\n      return newDst;\n    }\n    function round(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.round(v[0]);\n      newDst[1] = Math.round(v[1]);\n      newDst[2] = Math.round(v[2]);\n      newDst[3] = Math.round(v[3]);\n      return newDst;\n    }\n    function clamp(v, min2 = 0, max2 = 1, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.min(max2, Math.max(min2, v[0]));\n      newDst[1] = Math.min(max2, Math.max(min2, v[1]));\n      newDst[2] = Math.min(max2, Math.max(min2, v[2]));\n      newDst[3] = Math.min(max2, Math.max(min2, v[3]));\n      return newDst;\n    }\n    function add(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + b[0];\n      newDst[1] = a[1] + b[1];\n      newDst[2] = a[2] + b[2];\n      newDst[3] = a[3] + b[3];\n      return newDst;\n    }\n    function addScaled(a, b, scale2, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + b[0] * scale2;\n      newDst[1] = a[1] + b[1] * scale2;\n      newDst[2] = a[2] + b[2] * scale2;\n      newDst[3] = a[3] + b[3] * scale2;\n      return newDst;\n    }\n    function subtract(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] - b[0];\n      newDst[1] = a[1] - b[1];\n      newDst[2] = a[2] - b[2];\n      newDst[3] = a[3] - b[3];\n      return newDst;\n    }\n    const sub = subtract;\n    function equalsApproximately(a, b) {\n      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[3] - b[3]) < EPSILON;\n    }\n    function equals(a, b) {\n      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];\n    }\n    function lerp(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + t * (b[0] - a[0]);\n      newDst[1] = a[1] + t * (b[1] - a[1]);\n      newDst[2] = a[2] + t * (b[2] - a[2]);\n      newDst[3] = a[3] + t * (b[3] - a[3]);\n      return newDst;\n    }\n    function lerpV(a, b, t, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] + t[0] * (b[0] - a[0]);\n      newDst[1] = a[1] + t[1] * (b[1] - a[1]);\n      newDst[2] = a[2] + t[2] * (b[2] - a[2]);\n      newDst[3] = a[3] + t[3] * (b[3] - a[3]);\n      return newDst;\n    }\n    function max(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.max(a[0], b[0]);\n      newDst[1] = Math.max(a[1], b[1]);\n      newDst[2] = Math.max(a[2], b[2]);\n      newDst[3] = Math.max(a[3], b[3]);\n      return newDst;\n    }\n    function min(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = Math.min(a[0], b[0]);\n      newDst[1] = Math.min(a[1], b[1]);\n      newDst[2] = Math.min(a[2], b[2]);\n      newDst[3] = Math.min(a[3], b[3]);\n      return newDst;\n    }\n    function mulScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = v[0] * k;\n      newDst[1] = v[1] * k;\n      newDst[2] = v[2] * k;\n      newDst[3] = v[3] * k;\n      return newDst;\n    }\n    const scale = mulScalar;\n    function divScalar(v, k, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = v[0] / k;\n      newDst[1] = v[1] / k;\n      newDst[2] = v[2] / k;\n      newDst[3] = v[3] / k;\n      return newDst;\n    }\n    function inverse(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = 1 / v[0];\n      newDst[1] = 1 / v[1];\n      newDst[2] = 1 / v[2];\n      newDst[3] = 1 / v[3];\n      return newDst;\n    }\n    const invert = inverse;\n    function dot(a, b) {\n      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];\n    }\n    function length(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      return Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);\n    }\n    const len = length;\n    function lengthSq(v) {\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      return v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3;\n    }\n    const lenSq = lengthSq;\n    function distance(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      const dz = a[2] - b[2];\n      const dw = a[3] - b[3];\n      return Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw);\n    }\n    const dist = distance;\n    function distanceSq(a, b) {\n      const dx = a[0] - b[0];\n      const dy = a[1] - b[1];\n      const dz = a[2] - b[2];\n      const dw = a[3] - b[3];\n      return dx * dx + dy * dy + dz * dz + dw * dw;\n    }\n    const distSq = distanceSq;\n    function normalize(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const v0 = v[0];\n      const v1 = v[1];\n      const v2 = v[2];\n      const v3 = v[3];\n      const len2 = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);\n      if (len2 > 1e-5) {\n        newDst[0] = v0 / len2;\n        newDst[1] = v1 / len2;\n        newDst[2] = v2 / len2;\n        newDst[3] = v3 / len2;\n      } else {\n        newDst[0] = 0;\n        newDst[1] = 0;\n        newDst[2] = 0;\n        newDst[3] = 0;\n      }\n      return newDst;\n    }\n    function negate(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = -v[0];\n      newDst[1] = -v[1];\n      newDst[2] = -v[2];\n      newDst[3] = -v[3];\n      return newDst;\n    }\n    function copy(v, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = v[0];\n      newDst[1] = v[1];\n      newDst[2] = v[2];\n      newDst[3] = v[3];\n      return newDst;\n    }\n    const clone = copy;\n    function multiply(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] * b[0];\n      newDst[1] = a[1] * b[1];\n      newDst[2] = a[2] * b[2];\n      newDst[3] = a[3] * b[3];\n      return newDst;\n    }\n    const mul = multiply;\n    function divide(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = a[0] / b[0];\n      newDst[1] = a[1] / b[1];\n      newDst[2] = a[2] / b[2];\n      newDst[3] = a[3] / b[3];\n      return newDst;\n    }\n    const div = divide;\n    function zero(dst) {\n      const newDst = dst ?? new Ctor(4);\n      newDst[0] = 0;\n      newDst[1] = 0;\n      newDst[2] = 0;\n      newDst[3] = 0;\n      return newDst;\n    }\n    function transformMat4(v, m, dst) {\n      const newDst = dst ?? new Ctor(4);\n      const x = v[0];\n      const y = v[1];\n      const z = v[2];\n      const w = v[3];\n      newDst[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;\n      newDst[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;\n      newDst[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;\n      newDst[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;\n      return newDst;\n    }\n    function setLength(a, len2, dst) {\n      const newDst = dst ?? new Ctor(4);\n      normalize(a, newDst);\n      return mulScalar(newDst, len2, newDst);\n    }\n    function truncate(a, maxLen, dst) {\n      const newDst = dst ?? new Ctor(4);\n      if (length(a) > maxLen) {\n        return setLength(a, maxLen, newDst);\n      }\n      return copy(a, newDst);\n    }\n    function midpoint(a, b, dst) {\n      const newDst = dst ?? new Ctor(4);\n      return lerp(a, b, 0.5, newDst);\n    }\n    return {\n      create,\n      fromValues,\n      set,\n      ceil,\n      floor,\n      round,\n      clamp,\n      add,\n      addScaled,\n      subtract,\n      sub,\n      equalsApproximately,\n      equals,\n      lerp,\n      lerpV,\n      max,\n      min,\n      mulScalar,\n      scale,\n      divScalar,\n      inverse,\n      invert,\n      dot,\n      length,\n      len,\n      lengthSq,\n      lenSq,\n      distance,\n      dist,\n      distanceSq,\n      distSq,\n      normalize,\n      negate,\n      copy,\n      clone,\n      multiply,\n      mul,\n      divide,\n      div,\n      zero,\n      transformMat4,\n      setLength,\n      truncate,\n      midpoint\n    };\n  }\n  var cache = /* @__PURE__ */ new Map();\n  function getAPI(Ctor) {\n    let api = cache.get(Ctor);\n    if (!api) {\n      api = getAPIImpl(Ctor);\n      cache.set(Ctor, api);\n    }\n    return api;\n  }\n  function wgpuMatrixAPI(Mat3Ctor, Mat4Ctor, QuatCtor, Vec2Ctor, Vec3Ctor, Vec4Ctor) {\n    return {\n      /** @namespace mat4 */\n      mat4: getAPI$2(Mat3Ctor),\n      /** @namespace mat3 */\n      mat3: getAPI$4(Mat4Ctor),\n      /** @namespace quat */\n      quat: getAPI$1(QuatCtor),\n      /** @namespace vec2 */\n      vec2: getAPI$5(Vec2Ctor),\n      /** @namespace vec3 */\n      vec3: getAPI$3(Vec3Ctor),\n      /** @namespace vec4 */\n      vec4: getAPI(Vec4Ctor)\n    };\n  }\n  var {\n    /** @namespace */\n    mat4,\n    /** @namespace */\n    mat3,\n    /** @namespace */\n    quat,\n    /** @namespace */\n    vec2,\n    /** @namespace */\n    vec3,\n    /** @namespace */\n    vec4\n  } = wgpuMatrixAPI(Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array);\n  var {\n    /** @namespace */\n    mat4: mat4d,\n    /** @namespace */\n    mat3: mat3d,\n    /** @namespace */\n    quat: quatd,\n    /** @namespace */\n    vec2: vec2d,\n    /** @namespace */\n    vec3: vec3d,\n    /** @namespace */\n    vec4: vec4d\n  } = wgpuMatrixAPI(Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array);\n  var {\n    /** @namespace */\n    mat4: mat4n,\n    /** @namespace */\n    mat3: mat3n,\n    /** @namespace */\n    quat: quatn,\n    /** @namespace */\n    vec2: vec2n,\n    /** @namespace */\n    vec3: vec3n,\n    /** @namespace */\n    vec4: vec4n\n  } = wgpuMatrixAPI(ZeroArray, Array, Array, Array, Array, Array);\n\n  // worker_net.ts\n  var wt;\n  var frameId = 0;\n  function RecvMsgCb(msg) {\n  }\n  async function VcapMsgCb(msg) {\n    const chunk = msg.data.chunk;\n    const isKey = chunk.type == "key" ? 1 : 0;\n    const buf = new Uint8Array(frameHeaderLn + chunk.byteLength);\n    chunk.copyTo(buf.subarray(frameHeaderLn));\n    const view = new DataView(buf.buffer);\n    FrameHeaderWrite(view, frameId, chunk.timestamp, 0, isKey);\n    const writeStream = await wt.createUnidirectionalStream({ sendOrder: isKey ? sendOrderKeyframe : sendOrderDefault });\n    const writer = writeStream.getWriter();\n    writer.write(buf);\n    writer.releaseLock();\n    writeStream.close();\n    frameId++;\n  }\n  function WorkerMsgCb(msg) {\n    const recvPort = msg.data.recvPort;\n    const vcapPort = msg.data.vcapPort;\n    recvPort.onmessage = RecvMsgCb;\n    vcapPort.onmessage = VcapMsgCb;\n  }\n  function WorkerErrCb(err) {\n    console.error(err);\n  }\n  async function Main() {\n    const hashBytes = Uint8Array.fromHex("8142935cf816ade736327aab0b8de1f7c00292a8abac2c1dd9c450bd3a92c8cf");\n    wt = new WebTransport(\n      "https://127.0.0.1:4567/",\n      {\n        allowPooling: false,\n        serverCertificateHashes: [\n          {\n            algorithm: "sha-256",\n            value: hashBytes.buffer\n          }\n        ]\n      }\n    );\n    await wt.ready;\n  }\n  onmessage = WorkerMsgCb;\n  onerror = WorkerErrCb;\n  Main();\n})();\n';

  // util.ts
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
  function wrapConstructor(OriginalConstructor, modifier) {
    return class extends OriginalConstructor {
      constructor(...args) {
        super(...args);
        modifier(this);
      }
    };
  }
  var ZeroArray = wrapConstructor(Array, (a) => a.fill(0));
  var EPSILON = 1e-6;
  function getAPIImpl$5(Ctor) {
    function create(x = 0, y = 0) {
      const newDst = new Ctor(2);
      if (x !== void 0) {
        newDst[0] = x;
        if (y !== void 0) {
          newDst[1] = y;
        }
      }
      return newDst;
    }
    const fromValues = create;
    function set(x, y, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = x;
      newDst[1] = y;
      return newDst;
    }
    function ceil(v, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = Math.ceil(v[0]);
      newDst[1] = Math.ceil(v[1]);
      return newDst;
    }
    function floor(v, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = Math.floor(v[0]);
      newDst[1] = Math.floor(v[1]);
      return newDst;
    }
    function round(v, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = Math.round(v[0]);
      newDst[1] = Math.round(v[1]);
      return newDst;
    }
    function clamp(v, min2 = 0, max2 = 1, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = Math.min(max2, Math.max(min2, v[0]));
      newDst[1] = Math.min(max2, Math.max(min2, v[1]));
      return newDst;
    }
    function add(a, b, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = a[0] + b[0];
      newDst[1] = a[1] + b[1];
      return newDst;
    }
    function addScaled(a, b, scale2, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = a[0] + b[0] * scale2;
      newDst[1] = a[1] + b[1] * scale2;
      return newDst;
    }
    function angle(a, b) {
      const ax = a[0];
      const ay = a[1];
      const bx = b[0];
      const by = b[1];
      const mag1 = Math.sqrt(ax * ax + ay * ay);
      const mag2 = Math.sqrt(bx * bx + by * by);
      const mag = mag1 * mag2;
      const cosine = mag && dot(a, b) / mag;
      return Math.acos(cosine);
    }
    function subtract(a, b, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = a[0] - b[0];
      newDst[1] = a[1] - b[1];
      return newDst;
    }
    const sub = subtract;
    function equalsApproximately(a, b) {
      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON;
    }
    function equals(a, b) {
      return a[0] === b[0] && a[1] === b[1];
    }
    function lerp(a, b, t, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = a[0] + t * (b[0] - a[0]);
      newDst[1] = a[1] + t * (b[1] - a[1]);
      return newDst;
    }
    function lerpV(a, b, t, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = a[0] + t[0] * (b[0] - a[0]);
      newDst[1] = a[1] + t[1] * (b[1] - a[1]);
      return newDst;
    }
    function max(a, b, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = Math.max(a[0], b[0]);
      newDst[1] = Math.max(a[1], b[1]);
      return newDst;
    }
    function min(a, b, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = Math.min(a[0], b[0]);
      newDst[1] = Math.min(a[1], b[1]);
      return newDst;
    }
    function mulScalar(v, k, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = v[0] * k;
      newDst[1] = v[1] * k;
      return newDst;
    }
    const scale = mulScalar;
    function divScalar(v, k, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = v[0] / k;
      newDst[1] = v[1] / k;
      return newDst;
    }
    function inverse(v, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = 1 / v[0];
      newDst[1] = 1 / v[1];
      return newDst;
    }
    const invert = inverse;
    function cross(a, b, dst) {
      const newDst = dst ?? new Ctor(3);
      const z = a[0] * b[1] - a[1] * b[0];
      newDst[0] = 0;
      newDst[1] = 0;
      newDst[2] = z;
      return newDst;
    }
    function dot(a, b) {
      return a[0] * b[0] + a[1] * b[1];
    }
    function length(v) {
      const v0 = v[0];
      const v1 = v[1];
      return Math.sqrt(v0 * v0 + v1 * v1);
    }
    const len = length;
    function lengthSq(v) {
      const v0 = v[0];
      const v1 = v[1];
      return v0 * v0 + v1 * v1;
    }
    const lenSq = lengthSq;
    function distance(a, b) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      return Math.sqrt(dx * dx + dy * dy);
    }
    const dist = distance;
    function distanceSq(a, b) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      return dx * dx + dy * dy;
    }
    const distSq = distanceSq;
    function normalize(v, dst) {
      const newDst = dst ?? new Ctor(2);
      const v0 = v[0];
      const v1 = v[1];
      const len2 = Math.sqrt(v0 * v0 + v1 * v1);
      if (len2 > 1e-5) {
        newDst[0] = v0 / len2;
        newDst[1] = v1 / len2;
      } else {
        newDst[0] = 0;
        newDst[1] = 0;
      }
      return newDst;
    }
    function negate(v, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = -v[0];
      newDst[1] = -v[1];
      return newDst;
    }
    function copy(v, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = v[0];
      newDst[1] = v[1];
      return newDst;
    }
    const clone = copy;
    function multiply(a, b, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = a[0] * b[0];
      newDst[1] = a[1] * b[1];
      return newDst;
    }
    const mul = multiply;
    function divide(a, b, dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = a[0] / b[0];
      newDst[1] = a[1] / b[1];
      return newDst;
    }
    const div = divide;
    function random(scale2 = 1, dst) {
      const newDst = dst ?? new Ctor(2);
      const angle2 = Math.random() * 2 * Math.PI;
      newDst[0] = Math.cos(angle2) * scale2;
      newDst[1] = Math.sin(angle2) * scale2;
      return newDst;
    }
    function zero(dst) {
      const newDst = dst ?? new Ctor(2);
      newDst[0] = 0;
      newDst[1] = 0;
      return newDst;
    }
    function transformMat4(v, m, dst) {
      const newDst = dst ?? new Ctor(2);
      const x = v[0];
      const y = v[1];
      newDst[0] = x * m[0] + y * m[4] + m[12];
      newDst[1] = x * m[1] + y * m[5] + m[13];
      return newDst;
    }
    function transformMat3(v, m, dst) {
      const newDst = dst ?? new Ctor(2);
      const x = v[0];
      const y = v[1];
      newDst[0] = m[0] * x + m[4] * y + m[8];
      newDst[1] = m[1] * x + m[5] * y + m[9];
      return newDst;
    }
    function rotate(a, b, rad, dst) {
      const newDst = dst ?? new Ctor(2);
      const p0 = a[0] - b[0];
      const p1 = a[1] - b[1];
      const sinC = Math.sin(rad);
      const cosC = Math.cos(rad);
      newDst[0] = p0 * cosC - p1 * sinC + b[0];
      newDst[1] = p0 * sinC + p1 * cosC + b[1];
      return newDst;
    }
    function setLength(a, len2, dst) {
      const newDst = dst ?? new Ctor(2);
      normalize(a, newDst);
      return mulScalar(newDst, len2, newDst);
    }
    function truncate(a, maxLen, dst) {
      const newDst = dst ?? new Ctor(2);
      if (length(a) > maxLen) {
        return setLength(a, maxLen, newDst);
      }
      return copy(a, newDst);
    }
    function midpoint(a, b, dst) {
      const newDst = dst ?? new Ctor(2);
      return lerp(a, b, 0.5, newDst);
    }
    return {
      create,
      fromValues,
      set,
      ceil,
      floor,
      round,
      clamp,
      add,
      addScaled,
      angle,
      subtract,
      sub,
      equalsApproximately,
      equals,
      lerp,
      lerpV,
      max,
      min,
      mulScalar,
      scale,
      divScalar,
      inverse,
      invert,
      cross,
      dot,
      length,
      len,
      lengthSq,
      lenSq,
      distance,
      dist,
      distanceSq,
      distSq,
      normalize,
      negate,
      copy,
      clone,
      multiply,
      mul,
      divide,
      div,
      random,
      zero,
      transformMat4,
      transformMat3,
      rotate,
      setLength,
      truncate,
      midpoint
    };
  }
  var cache$5 = /* @__PURE__ */ new Map();
  function getAPI$5(Ctor) {
    let api = cache$5.get(Ctor);
    if (!api) {
      api = getAPIImpl$5(Ctor);
      cache$5.set(Ctor, api);
    }
    return api;
  }
  function getAPIImpl$4(Ctor) {
    const vec22 = getAPI$5(Ctor);
    function create(v0, v1, v2, v3, v4, v5, v6, v7, v8) {
      const newDst = new Ctor(12);
      newDst[3] = 0;
      newDst[7] = 0;
      newDst[11] = 0;
      if (v0 !== void 0) {
        newDst[0] = v0;
        if (v1 !== void 0) {
          newDst[1] = v1;
          if (v2 !== void 0) {
            newDst[2] = v2;
            if (v3 !== void 0) {
              newDst[4] = v3;
              if (v4 !== void 0) {
                newDst[5] = v4;
                if (v5 !== void 0) {
                  newDst[6] = v5;
                  if (v6 !== void 0) {
                    newDst[8] = v6;
                    if (v7 !== void 0) {
                      newDst[9] = v7;
                      if (v8 !== void 0) {
                        newDst[10] = v8;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      return newDst;
    }
    function set(v0, v1, v2, v3, v4, v5, v6, v7, v8, dst) {
      const newDst = dst ?? new Ctor(12);
      newDst[0] = v0;
      newDst[1] = v1;
      newDst[2] = v2;
      newDst[3] = 0;
      newDst[4] = v3;
      newDst[5] = v4;
      newDst[6] = v5;
      newDst[7] = 0;
      newDst[8] = v6;
      newDst[9] = v7;
      newDst[10] = v8;
      newDst[11] = 0;
      return newDst;
    }
    function fromMat4(m4, dst) {
      const newDst = dst ?? new Ctor(12);
      newDst[0] = m4[0];
      newDst[1] = m4[1];
      newDst[2] = m4[2];
      newDst[3] = 0;
      newDst[4] = m4[4];
      newDst[5] = m4[5];
      newDst[6] = m4[6];
      newDst[7] = 0;
      newDst[8] = m4[8];
      newDst[9] = m4[9];
      newDst[10] = m4[10];
      newDst[11] = 0;
      return newDst;
    }
    function fromQuat(q, dst) {
      const newDst = dst ?? new Ctor(12);
      const x = q[0];
      const y = q[1];
      const z = q[2];
      const w = q[3];
      const x2 = x + x;
      const y2 = y + y;
      const z2 = z + z;
      const xx = x * x2;
      const yx = y * x2;
      const yy = y * y2;
      const zx = z * x2;
      const zy = z * y2;
      const zz = z * z2;
      const wx = w * x2;
      const wy = w * y2;
      const wz = w * z2;
      newDst[0] = 1 - yy - zz;
      newDst[1] = yx + wz;
      newDst[2] = zx - wy;
      newDst[3] = 0;
      newDst[4] = yx - wz;
      newDst[5] = 1 - xx - zz;
      newDst[6] = zy + wx;
      newDst[7] = 0;
      newDst[8] = zx + wy;
      newDst[9] = zy - wx;
      newDst[10] = 1 - xx - yy;
      newDst[11] = 0;
      return newDst;
    }
    function negate(m, dst) {
      const newDst = dst ?? new Ctor(12);
      newDst[0] = -m[0];
      newDst[1] = -m[1];
      newDst[2] = -m[2];
      newDst[4] = -m[4];
      newDst[5] = -m[5];
      newDst[6] = -m[6];
      newDst[8] = -m[8];
      newDst[9] = -m[9];
      newDst[10] = -m[10];
      return newDst;
    }
    function copy(m, dst) {
      const newDst = dst ?? new Ctor(12);
      newDst[0] = m[0];
      newDst[1] = m[1];
      newDst[2] = m[2];
      newDst[4] = m[4];
      newDst[5] = m[5];
      newDst[6] = m[6];
      newDst[8] = m[8];
      newDst[9] = m[9];
      newDst[10] = m[10];
      return newDst;
    }
    const clone = copy;
    function equalsApproximately(a, b) {
      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[4] - b[4]) < EPSILON && Math.abs(a[5] - b[5]) < EPSILON && Math.abs(a[6] - b[6]) < EPSILON && Math.abs(a[8] - b[8]) < EPSILON && Math.abs(a[9] - b[9]) < EPSILON && Math.abs(a[10] - b[10]) < EPSILON;
    }
    function equals(a, b) {
      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[4] === b[4] && a[5] === b[5] && a[6] === b[6] && a[8] === b[8] && a[9] === b[9] && a[10] === b[10];
    }
    function identity(dst) {
      const newDst = dst ?? new Ctor(12);
      newDst[0] = 1;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[4] = 0;
      newDst[5] = 1;
      newDst[6] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[10] = 1;
      return newDst;
    }
    function transpose(m, dst) {
      const newDst = dst ?? new Ctor(12);
      if (newDst === m) {
        let t;
        t = m[1];
        m[1] = m[4];
        m[4] = t;
        t = m[2];
        m[2] = m[8];
        m[8] = t;
        t = m[6];
        m[6] = m[9];
        m[9] = t;
        return newDst;
      }
      const m00 = m[0 * 4 + 0];
      const m01 = m[0 * 4 + 1];
      const m02 = m[0 * 4 + 2];
      const m10 = m[1 * 4 + 0];
      const m11 = m[1 * 4 + 1];
      const m12 = m[1 * 4 + 2];
      const m20 = m[2 * 4 + 0];
      const m21 = m[2 * 4 + 1];
      const m22 = m[2 * 4 + 2];
      newDst[0] = m00;
      newDst[1] = m10;
      newDst[2] = m20;
      newDst[4] = m01;
      newDst[5] = m11;
      newDst[6] = m21;
      newDst[8] = m02;
      newDst[9] = m12;
      newDst[10] = m22;
      return newDst;
    }
    function inverse(m, dst) {
      const newDst = dst ?? new Ctor(12);
      const m00 = m[0 * 4 + 0];
      const m01 = m[0 * 4 + 1];
      const m02 = m[0 * 4 + 2];
      const m10 = m[1 * 4 + 0];
      const m11 = m[1 * 4 + 1];
      const m12 = m[1 * 4 + 2];
      const m20 = m[2 * 4 + 0];
      const m21 = m[2 * 4 + 1];
      const m22 = m[2 * 4 + 2];
      const b01 = m22 * m11 - m12 * m21;
      const b11 = -m22 * m10 + m12 * m20;
      const b21 = m21 * m10 - m11 * m20;
      const invDet = 1 / (m00 * b01 + m01 * b11 + m02 * b21);
      newDst[0] = b01 * invDet;
      newDst[1] = (-m22 * m01 + m02 * m21) * invDet;
      newDst[2] = (m12 * m01 - m02 * m11) * invDet;
      newDst[4] = b11 * invDet;
      newDst[5] = (m22 * m00 - m02 * m20) * invDet;
      newDst[6] = (-m12 * m00 + m02 * m10) * invDet;
      newDst[8] = b21 * invDet;
      newDst[9] = (-m21 * m00 + m01 * m20) * invDet;
      newDst[10] = (m11 * m00 - m01 * m10) * invDet;
      return newDst;
    }
    function determinant(m) {
      const m00 = m[0 * 4 + 0];
      const m01 = m[0 * 4 + 1];
      const m02 = m[0 * 4 + 2];
      const m10 = m[1 * 4 + 0];
      const m11 = m[1 * 4 + 1];
      const m12 = m[1 * 4 + 2];
      const m20 = m[2 * 4 + 0];
      const m21 = m[2 * 4 + 1];
      const m22 = m[2 * 4 + 2];
      return m00 * (m11 * m22 - m21 * m12) - m10 * (m01 * m22 - m21 * m02) + m20 * (m01 * m12 - m11 * m02);
    }
    const invert = inverse;
    function multiply(a, b, dst) {
      const newDst = dst ?? new Ctor(12);
      const a00 = a[0];
      const a01 = a[1];
      const a02 = a[2];
      const a10 = a[4 + 0];
      const a11 = a[4 + 1];
      const a12 = a[4 + 2];
      const a20 = a[8 + 0];
      const a21 = a[8 + 1];
      const a22 = a[8 + 2];
      const b00 = b[0];
      const b01 = b[1];
      const b02 = b[2];
      const b10 = b[4 + 0];
      const b11 = b[4 + 1];
      const b12 = b[4 + 2];
      const b20 = b[8 + 0];
      const b21 = b[8 + 1];
      const b22 = b[8 + 2];
      newDst[0] = a00 * b00 + a10 * b01 + a20 * b02;
      newDst[1] = a01 * b00 + a11 * b01 + a21 * b02;
      newDst[2] = a02 * b00 + a12 * b01 + a22 * b02;
      newDst[4] = a00 * b10 + a10 * b11 + a20 * b12;
      newDst[5] = a01 * b10 + a11 * b11 + a21 * b12;
      newDst[6] = a02 * b10 + a12 * b11 + a22 * b12;
      newDst[8] = a00 * b20 + a10 * b21 + a20 * b22;
      newDst[9] = a01 * b20 + a11 * b21 + a21 * b22;
      newDst[10] = a02 * b20 + a12 * b21 + a22 * b22;
      return newDst;
    }
    const mul = multiply;
    function setTranslation(a, v, dst) {
      const newDst = dst ?? identity();
      if (a !== newDst) {
        newDst[0] = a[0];
        newDst[1] = a[1];
        newDst[2] = a[2];
        newDst[4] = a[4];
        newDst[5] = a[5];
        newDst[6] = a[6];
      }
      newDst[8] = v[0];
      newDst[9] = v[1];
      newDst[10] = 1;
      return newDst;
    }
    function getTranslation(m, dst) {
      const newDst = dst ?? vec22.create();
      newDst[0] = m[8];
      newDst[1] = m[9];
      return newDst;
    }
    function getAxis(m, axis, dst) {
      const newDst = dst ?? vec22.create();
      const off = axis * 4;
      newDst[0] = m[off + 0];
      newDst[1] = m[off + 1];
      return newDst;
    }
    function setAxis(m, v, axis, dst) {
      const newDst = dst === m ? m : copy(m, dst);
      const off = axis * 4;
      newDst[off + 0] = v[0];
      newDst[off + 1] = v[1];
      return newDst;
    }
    function getScaling(m, dst) {
      const newDst = dst ?? vec22.create();
      const xx = m[0];
      const xy = m[1];
      const yx = m[4];
      const yy = m[5];
      newDst[0] = Math.sqrt(xx * xx + xy * xy);
      newDst[1] = Math.sqrt(yx * yx + yy * yy);
      return newDst;
    }
    function translation(v, dst) {
      const newDst = dst ?? new Ctor(12);
      newDst[0] = 1;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[4] = 0;
      newDst[5] = 1;
      newDst[6] = 0;
      newDst[8] = v[0];
      newDst[9] = v[1];
      newDst[10] = 1;
      return newDst;
    }
    function translate(m, v, dst) {
      const newDst = dst ?? new Ctor(12);
      const v0 = v[0];
      const v1 = v[1];
      const m00 = m[0];
      const m01 = m[1];
      const m02 = m[2];
      const m10 = m[1 * 4 + 0];
      const m11 = m[1 * 4 + 1];
      const m12 = m[1 * 4 + 2];
      const m20 = m[2 * 4 + 0];
      const m21 = m[2 * 4 + 1];
      const m22 = m[2 * 4 + 2];
      if (m !== newDst) {
        newDst[0] = m00;
        newDst[1] = m01;
        newDst[2] = m02;
        newDst[4] = m10;
        newDst[5] = m11;
        newDst[6] = m12;
      }
      newDst[8] = m00 * v0 + m10 * v1 + m20;
      newDst[9] = m01 * v0 + m11 * v1 + m21;
      newDst[10] = m02 * v0 + m12 * v1 + m22;
      return newDst;
    }
    function rotation(angleInRadians, dst) {
      const newDst = dst ?? new Ctor(12);
      const c = Math.cos(angleInRadians);
      const s = Math.sin(angleInRadians);
      newDst[0] = c;
      newDst[1] = s;
      newDst[2] = 0;
      newDst[4] = -s;
      newDst[5] = c;
      newDst[6] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[10] = 1;
      return newDst;
    }
    function rotate(m, angleInRadians, dst) {
      const newDst = dst ?? new Ctor(12);
      const m00 = m[0 * 4 + 0];
      const m01 = m[0 * 4 + 1];
      const m02 = m[0 * 4 + 2];
      const m10 = m[1 * 4 + 0];
      const m11 = m[1 * 4 + 1];
      const m12 = m[1 * 4 + 2];
      const c = Math.cos(angleInRadians);
      const s = Math.sin(angleInRadians);
      newDst[0] = c * m00 + s * m10;
      newDst[1] = c * m01 + s * m11;
      newDst[2] = c * m02 + s * m12;
      newDst[4] = c * m10 - s * m00;
      newDst[5] = c * m11 - s * m01;
      newDst[6] = c * m12 - s * m02;
      if (m !== newDst) {
        newDst[8] = m[8];
        newDst[9] = m[9];
        newDst[10] = m[10];
      }
      return newDst;
    }
    function scaling(v, dst) {
      const newDst = dst ?? new Ctor(12);
      newDst[0] = v[0];
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[4] = 0;
      newDst[5] = v[1];
      newDst[6] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[10] = 1;
      return newDst;
    }
    function scale(m, v, dst) {
      const newDst = dst ?? new Ctor(12);
      const v0 = v[0];
      const v1 = v[1];
      newDst[0] = v0 * m[0 * 4 + 0];
      newDst[1] = v0 * m[0 * 4 + 1];
      newDst[2] = v0 * m[0 * 4 + 2];
      newDst[4] = v1 * m[1 * 4 + 0];
      newDst[5] = v1 * m[1 * 4 + 1];
      newDst[6] = v1 * m[1 * 4 + 2];
      if (m !== newDst) {
        newDst[8] = m[8];
        newDst[9] = m[9];
        newDst[10] = m[10];
      }
      return newDst;
    }
    function uniformScaling(s, dst) {
      const newDst = dst ?? new Ctor(12);
      newDst[0] = s;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[4] = 0;
      newDst[5] = s;
      newDst[6] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[10] = 1;
      return newDst;
    }
    function uniformScale(m, s, dst) {
      const newDst = dst ?? new Ctor(12);
      newDst[0] = s * m[0 * 4 + 0];
      newDst[1] = s * m[0 * 4 + 1];
      newDst[2] = s * m[0 * 4 + 2];
      newDst[4] = s * m[1 * 4 + 0];
      newDst[5] = s * m[1 * 4 + 1];
      newDst[6] = s * m[1 * 4 + 2];
      if (m !== newDst) {
        newDst[8] = m[8];
        newDst[9] = m[9];
        newDst[10] = m[10];
      }
      return newDst;
    }
    return {
      clone,
      create,
      set,
      fromMat4,
      fromQuat,
      negate,
      copy,
      equalsApproximately,
      equals,
      identity,
      transpose,
      inverse,
      invert,
      determinant,
      mul,
      multiply,
      setTranslation,
      getTranslation,
      getAxis,
      setAxis,
      getScaling,
      translation,
      translate,
      rotation,
      rotate,
      scaling,
      scale,
      uniformScaling,
      uniformScale
    };
  }
  var cache$4 = /* @__PURE__ */ new Map();
  function getAPI$4(Ctor) {
    let api = cache$4.get(Ctor);
    if (!api) {
      api = getAPIImpl$4(Ctor);
      cache$4.set(Ctor, api);
    }
    return api;
  }
  function getAPIImpl$3(Ctor) {
    function create(x, y, z) {
      const newDst = new Ctor(3);
      if (x !== void 0) {
        newDst[0] = x;
        if (y !== void 0) {
          newDst[1] = y;
          if (z !== void 0) {
            newDst[2] = z;
          }
        }
      }
      return newDst;
    }
    const fromValues = create;
    function set(x, y, z, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = x;
      newDst[1] = y;
      newDst[2] = z;
      return newDst;
    }
    function ceil(v, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = Math.ceil(v[0]);
      newDst[1] = Math.ceil(v[1]);
      newDst[2] = Math.ceil(v[2]);
      return newDst;
    }
    function floor(v, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = Math.floor(v[0]);
      newDst[1] = Math.floor(v[1]);
      newDst[2] = Math.floor(v[2]);
      return newDst;
    }
    function round(v, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = Math.round(v[0]);
      newDst[1] = Math.round(v[1]);
      newDst[2] = Math.round(v[2]);
      return newDst;
    }
    function clamp(v, min2 = 0, max2 = 1, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = Math.min(max2, Math.max(min2, v[0]));
      newDst[1] = Math.min(max2, Math.max(min2, v[1]));
      newDst[2] = Math.min(max2, Math.max(min2, v[2]));
      return newDst;
    }
    function add(a, b, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = a[0] + b[0];
      newDst[1] = a[1] + b[1];
      newDst[2] = a[2] + b[2];
      return newDst;
    }
    function addScaled(a, b, scale2, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = a[0] + b[0] * scale2;
      newDst[1] = a[1] + b[1] * scale2;
      newDst[2] = a[2] + b[2] * scale2;
      return newDst;
    }
    function angle(a, b) {
      const ax = a[0];
      const ay = a[1];
      const az = a[2];
      const bx = b[0];
      const by = b[1];
      const bz = b[2];
      const mag1 = Math.sqrt(ax * ax + ay * ay + az * az);
      const mag2 = Math.sqrt(bx * bx + by * by + bz * bz);
      const mag = mag1 * mag2;
      const cosine = mag && dot(a, b) / mag;
      return Math.acos(cosine);
    }
    function subtract(a, b, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = a[0] - b[0];
      newDst[1] = a[1] - b[1];
      newDst[2] = a[2] - b[2];
      return newDst;
    }
    const sub = subtract;
    function equalsApproximately(a, b) {
      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON;
    }
    function equals(a, b) {
      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    }
    function lerp(a, b, t, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = a[0] + t * (b[0] - a[0]);
      newDst[1] = a[1] + t * (b[1] - a[1]);
      newDst[2] = a[2] + t * (b[2] - a[2]);
      return newDst;
    }
    function lerpV(a, b, t, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = a[0] + t[0] * (b[0] - a[0]);
      newDst[1] = a[1] + t[1] * (b[1] - a[1]);
      newDst[2] = a[2] + t[2] * (b[2] - a[2]);
      return newDst;
    }
    function max(a, b, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = Math.max(a[0], b[0]);
      newDst[1] = Math.max(a[1], b[1]);
      newDst[2] = Math.max(a[2], b[2]);
      return newDst;
    }
    function min(a, b, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = Math.min(a[0], b[0]);
      newDst[1] = Math.min(a[1], b[1]);
      newDst[2] = Math.min(a[2], b[2]);
      return newDst;
    }
    function mulScalar(v, k, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = v[0] * k;
      newDst[1] = v[1] * k;
      newDst[2] = v[2] * k;
      return newDst;
    }
    const scale = mulScalar;
    function divScalar(v, k, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = v[0] / k;
      newDst[1] = v[1] / k;
      newDst[2] = v[2] / k;
      return newDst;
    }
    function inverse(v, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = 1 / v[0];
      newDst[1] = 1 / v[1];
      newDst[2] = 1 / v[2];
      return newDst;
    }
    const invert = inverse;
    function cross(a, b, dst) {
      const newDst = dst ?? new Ctor(3);
      const t1 = a[2] * b[0] - a[0] * b[2];
      const t2 = a[0] * b[1] - a[1] * b[0];
      newDst[0] = a[1] * b[2] - a[2] * b[1];
      newDst[1] = t1;
      newDst[2] = t2;
      return newDst;
    }
    function dot(a, b) {
      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }
    function length(v) {
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      return Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2);
    }
    const len = length;
    function lengthSq(v) {
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      return v0 * v0 + v1 * v1 + v2 * v2;
    }
    const lenSq = lengthSq;
    function distance(a, b) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const dist = distance;
    function distanceSq(a, b) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      return dx * dx + dy * dy + dz * dz;
    }
    const distSq = distanceSq;
    function normalize(v, dst) {
      const newDst = dst ?? new Ctor(3);
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      const len2 = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2);
      if (len2 > 1e-5) {
        newDst[0] = v0 / len2;
        newDst[1] = v1 / len2;
        newDst[2] = v2 / len2;
      } else {
        newDst[0] = 0;
        newDst[1] = 0;
        newDst[2] = 0;
      }
      return newDst;
    }
    function negate(v, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = -v[0];
      newDst[1] = -v[1];
      newDst[2] = -v[2];
      return newDst;
    }
    function copy(v, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = v[0];
      newDst[1] = v[1];
      newDst[2] = v[2];
      return newDst;
    }
    const clone = copy;
    function multiply(a, b, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = a[0] * b[0];
      newDst[1] = a[1] * b[1];
      newDst[2] = a[2] * b[2];
      return newDst;
    }
    const mul = multiply;
    function divide(a, b, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = a[0] / b[0];
      newDst[1] = a[1] / b[1];
      newDst[2] = a[2] / b[2];
      return newDst;
    }
    const div = divide;
    function random(scale2 = 1, dst) {
      const newDst = dst ?? new Ctor(3);
      const angle2 = Math.random() * 2 * Math.PI;
      const z = Math.random() * 2 - 1;
      const zScale = Math.sqrt(1 - z * z) * scale2;
      newDst[0] = Math.cos(angle2) * zScale;
      newDst[1] = Math.sin(angle2) * zScale;
      newDst[2] = z * scale2;
      return newDst;
    }
    function zero(dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = 0;
      newDst[1] = 0;
      newDst[2] = 0;
      return newDst;
    }
    function transformMat4(v, m, dst) {
      const newDst = dst ?? new Ctor(3);
      const x = v[0];
      const y = v[1];
      const z = v[2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
      newDst[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      newDst[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      newDst[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
      return newDst;
    }
    function transformMat4Upper3x3(v, m, dst) {
      const newDst = dst ?? new Ctor(3);
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      newDst[0] = v0 * m[0 * 4 + 0] + v1 * m[1 * 4 + 0] + v2 * m[2 * 4 + 0];
      newDst[1] = v0 * m[0 * 4 + 1] + v1 * m[1 * 4 + 1] + v2 * m[2 * 4 + 1];
      newDst[2] = v0 * m[0 * 4 + 2] + v1 * m[1 * 4 + 2] + v2 * m[2 * 4 + 2];
      return newDst;
    }
    function transformMat3(v, m, dst) {
      const newDst = dst ?? new Ctor(3);
      const x = v[0];
      const y = v[1];
      const z = v[2];
      newDst[0] = x * m[0] + y * m[4] + z * m[8];
      newDst[1] = x * m[1] + y * m[5] + z * m[9];
      newDst[2] = x * m[2] + y * m[6] + z * m[10];
      return newDst;
    }
    function transformQuat(v, q, dst) {
      const newDst = dst ?? new Ctor(3);
      const qx = q[0];
      const qy = q[1];
      const qz = q[2];
      const w2 = q[3] * 2;
      const x = v[0];
      const y = v[1];
      const z = v[2];
      const uvX = qy * z - qz * y;
      const uvY = qz * x - qx * z;
      const uvZ = qx * y - qy * x;
      newDst[0] = x + uvX * w2 + (qy * uvZ - qz * uvY) * 2;
      newDst[1] = y + uvY * w2 + (qz * uvX - qx * uvZ) * 2;
      newDst[2] = z + uvZ * w2 + (qx * uvY - qy * uvX) * 2;
      return newDst;
    }
    function getTranslation(m, dst) {
      const newDst = dst ?? new Ctor(3);
      newDst[0] = m[12];
      newDst[1] = m[13];
      newDst[2] = m[14];
      return newDst;
    }
    function getAxis(m, axis, dst) {
      const newDst = dst ?? new Ctor(3);
      const off = axis * 4;
      newDst[0] = m[off + 0];
      newDst[1] = m[off + 1];
      newDst[2] = m[off + 2];
      return newDst;
    }
    function getScaling(m, dst) {
      const newDst = dst ?? new Ctor(3);
      const xx = m[0];
      const xy = m[1];
      const xz = m[2];
      const yx = m[4];
      const yy = m[5];
      const yz = m[6];
      const zx = m[8];
      const zy = m[9];
      const zz = m[10];
      newDst[0] = Math.sqrt(xx * xx + xy * xy + xz * xz);
      newDst[1] = Math.sqrt(yx * yx + yy * yy + yz * yz);
      newDst[2] = Math.sqrt(zx * zx + zy * zy + zz * zz);
      return newDst;
    }
    function rotateX(a, b, rad, dst) {
      const newDst = dst ?? new Ctor(3);
      const p = [];
      const r = [];
      p[0] = a[0] - b[0];
      p[1] = a[1] - b[1];
      p[2] = a[2] - b[2];
      r[0] = p[0];
      r[1] = p[1] * Math.cos(rad) - p[2] * Math.sin(rad);
      r[2] = p[1] * Math.sin(rad) + p[2] * Math.cos(rad);
      newDst[0] = r[0] + b[0];
      newDst[1] = r[1] + b[1];
      newDst[2] = r[2] + b[2];
      return newDst;
    }
    function rotateY(a, b, rad, dst) {
      const newDst = dst ?? new Ctor(3);
      const p = [];
      const r = [];
      p[0] = a[0] - b[0];
      p[1] = a[1] - b[1];
      p[2] = a[2] - b[2];
      r[0] = p[2] * Math.sin(rad) + p[0] * Math.cos(rad);
      r[1] = p[1];
      r[2] = p[2] * Math.cos(rad) - p[0] * Math.sin(rad);
      newDst[0] = r[0] + b[0];
      newDst[1] = r[1] + b[1];
      newDst[2] = r[2] + b[2];
      return newDst;
    }
    function rotateZ(a, b, rad, dst) {
      const newDst = dst ?? new Ctor(3);
      const p = [];
      const r = [];
      p[0] = a[0] - b[0];
      p[1] = a[1] - b[1];
      p[2] = a[2] - b[2];
      r[0] = p[0] * Math.cos(rad) - p[1] * Math.sin(rad);
      r[1] = p[0] * Math.sin(rad) + p[1] * Math.cos(rad);
      r[2] = p[2];
      newDst[0] = r[0] + b[0];
      newDst[1] = r[1] + b[1];
      newDst[2] = r[2] + b[2];
      return newDst;
    }
    function setLength(a, len2, dst) {
      const newDst = dst ?? new Ctor(3);
      normalize(a, newDst);
      return mulScalar(newDst, len2, newDst);
    }
    function truncate(a, maxLen, dst) {
      const newDst = dst ?? new Ctor(3);
      if (length(a) > maxLen) {
        return setLength(a, maxLen, newDst);
      }
      return copy(a, newDst);
    }
    function midpoint(a, b, dst) {
      const newDst = dst ?? new Ctor(3);
      return lerp(a, b, 0.5, newDst);
    }
    return {
      create,
      fromValues,
      set,
      ceil,
      floor,
      round,
      clamp,
      add,
      addScaled,
      angle,
      subtract,
      sub,
      equalsApproximately,
      equals,
      lerp,
      lerpV,
      max,
      min,
      mulScalar,
      scale,
      divScalar,
      inverse,
      invert,
      cross,
      dot,
      length,
      len,
      lengthSq,
      lenSq,
      distance,
      dist,
      distanceSq,
      distSq,
      normalize,
      negate,
      copy,
      clone,
      multiply,
      mul,
      divide,
      div,
      random,
      zero,
      transformMat4,
      transformMat4Upper3x3,
      transformMat3,
      transformQuat,
      getTranslation,
      getAxis,
      getScaling,
      rotateX,
      rotateY,
      rotateZ,
      setLength,
      truncate,
      midpoint
    };
  }
  var cache$3 = /* @__PURE__ */ new Map();
  function getAPI$3(Ctor) {
    let api = cache$3.get(Ctor);
    if (!api) {
      api = getAPIImpl$3(Ctor);
      cache$3.set(Ctor, api);
    }
    return api;
  }
  function getAPIImpl$2(Ctor) {
    const vec32 = getAPI$3(Ctor);
    function create(v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15) {
      const newDst = new Ctor(16);
      if (v0 !== void 0) {
        newDst[0] = v0;
        if (v1 !== void 0) {
          newDst[1] = v1;
          if (v2 !== void 0) {
            newDst[2] = v2;
            if (v3 !== void 0) {
              newDst[3] = v3;
              if (v4 !== void 0) {
                newDst[4] = v4;
                if (v5 !== void 0) {
                  newDst[5] = v5;
                  if (v6 !== void 0) {
                    newDst[6] = v6;
                    if (v7 !== void 0) {
                      newDst[7] = v7;
                      if (v8 !== void 0) {
                        newDst[8] = v8;
                        if (v9 !== void 0) {
                          newDst[9] = v9;
                          if (v10 !== void 0) {
                            newDst[10] = v10;
                            if (v11 !== void 0) {
                              newDst[11] = v11;
                              if (v12 !== void 0) {
                                newDst[12] = v12;
                                if (v13 !== void 0) {
                                  newDst[13] = v13;
                                  if (v14 !== void 0) {
                                    newDst[14] = v14;
                                    if (v15 !== void 0) {
                                      newDst[15] = v15;
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      return newDst;
    }
    function set(v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, dst) {
      const newDst = dst ?? new Ctor(16);
      newDst[0] = v0;
      newDst[1] = v1;
      newDst[2] = v2;
      newDst[3] = v3;
      newDst[4] = v4;
      newDst[5] = v5;
      newDst[6] = v6;
      newDst[7] = v7;
      newDst[8] = v8;
      newDst[9] = v9;
      newDst[10] = v10;
      newDst[11] = v11;
      newDst[12] = v12;
      newDst[13] = v13;
      newDst[14] = v14;
      newDst[15] = v15;
      return newDst;
    }
    function fromMat3(m3, dst) {
      const newDst = dst ?? new Ctor(16);
      newDst[0] = m3[0];
      newDst[1] = m3[1];
      newDst[2] = m3[2];
      newDst[3] = 0;
      newDst[4] = m3[4];
      newDst[5] = m3[5];
      newDst[6] = m3[6];
      newDst[7] = 0;
      newDst[8] = m3[8];
      newDst[9] = m3[9];
      newDst[10] = m3[10];
      newDst[11] = 0;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[14] = 0;
      newDst[15] = 1;
      return newDst;
    }
    function fromQuat(q, dst) {
      const newDst = dst ?? new Ctor(16);
      const x = q[0];
      const y = q[1];
      const z = q[2];
      const w = q[3];
      const x2 = x + x;
      const y2 = y + y;
      const z2 = z + z;
      const xx = x * x2;
      const yx = y * x2;
      const yy = y * y2;
      const zx = z * x2;
      const zy = z * y2;
      const zz = z * z2;
      const wx = w * x2;
      const wy = w * y2;
      const wz = w * z2;
      newDst[0] = 1 - yy - zz;
      newDst[1] = yx + wz;
      newDst[2] = zx - wy;
      newDst[3] = 0;
      newDst[4] = yx - wz;
      newDst[5] = 1 - xx - zz;
      newDst[6] = zy + wx;
      newDst[7] = 0;
      newDst[8] = zx + wy;
      newDst[9] = zy - wx;
      newDst[10] = 1 - xx - yy;
      newDst[11] = 0;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[14] = 0;
      newDst[15] = 1;
      return newDst;
    }
    function negate(m, dst) {
      const newDst = dst ?? new Ctor(16);
      newDst[0] = -m[0];
      newDst[1] = -m[1];
      newDst[2] = -m[2];
      newDst[3] = -m[3];
      newDst[4] = -m[4];
      newDst[5] = -m[5];
      newDst[6] = -m[6];
      newDst[7] = -m[7];
      newDst[8] = -m[8];
      newDst[9] = -m[9];
      newDst[10] = -m[10];
      newDst[11] = -m[11];
      newDst[12] = -m[12];
      newDst[13] = -m[13];
      newDst[14] = -m[14];
      newDst[15] = -m[15];
      return newDst;
    }
    function copy(m, dst) {
      const newDst = dst ?? new Ctor(16);
      newDst[0] = m[0];
      newDst[1] = m[1];
      newDst[2] = m[2];
      newDst[3] = m[3];
      newDst[4] = m[4];
      newDst[5] = m[5];
      newDst[6] = m[6];
      newDst[7] = m[7];
      newDst[8] = m[8];
      newDst[9] = m[9];
      newDst[10] = m[10];
      newDst[11] = m[11];
      newDst[12] = m[12];
      newDst[13] = m[13];
      newDst[14] = m[14];
      newDst[15] = m[15];
      return newDst;
    }
    const clone = copy;
    function equalsApproximately(a, b) {
      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[3] - b[3]) < EPSILON && Math.abs(a[4] - b[4]) < EPSILON && Math.abs(a[5] - b[5]) < EPSILON && Math.abs(a[6] - b[6]) < EPSILON && Math.abs(a[7] - b[7]) < EPSILON && Math.abs(a[8] - b[8]) < EPSILON && Math.abs(a[9] - b[9]) < EPSILON && Math.abs(a[10] - b[10]) < EPSILON && Math.abs(a[11] - b[11]) < EPSILON && Math.abs(a[12] - b[12]) < EPSILON && Math.abs(a[13] - b[13]) < EPSILON && Math.abs(a[14] - b[14]) < EPSILON && Math.abs(a[15] - b[15]) < EPSILON;
    }
    function equals(a, b) {
      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5] && a[6] === b[6] && a[7] === b[7] && a[8] === b[8] && a[9] === b[9] && a[10] === b[10] && a[11] === b[11] && a[12] === b[12] && a[13] === b[13] && a[14] === b[14] && a[15] === b[15];
    }
    function identity(dst) {
      const newDst = dst ?? new Ctor(16);
      newDst[0] = 1;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = 1;
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[10] = 1;
      newDst[11] = 0;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[14] = 0;
      newDst[15] = 1;
      return newDst;
    }
    function transpose(m, dst) {
      const newDst = dst ?? new Ctor(16);
      if (newDst === m) {
        let t;
        t = m[1];
        m[1] = m[4];
        m[4] = t;
        t = m[2];
        m[2] = m[8];
        m[8] = t;
        t = m[3];
        m[3] = m[12];
        m[12] = t;
        t = m[6];
        m[6] = m[9];
        m[9] = t;
        t = m[7];
        m[7] = m[13];
        m[13] = t;
        t = m[11];
        m[11] = m[14];
        m[14] = t;
        return newDst;
      }
      const m00 = m[0 * 4 + 0];
      const m01 = m[0 * 4 + 1];
      const m02 = m[0 * 4 + 2];
      const m03 = m[0 * 4 + 3];
      const m10 = m[1 * 4 + 0];
      const m11 = m[1 * 4 + 1];
      const m12 = m[1 * 4 + 2];
      const m13 = m[1 * 4 + 3];
      const m20 = m[2 * 4 + 0];
      const m21 = m[2 * 4 + 1];
      const m22 = m[2 * 4 + 2];
      const m23 = m[2 * 4 + 3];
      const m30 = m[3 * 4 + 0];
      const m31 = m[3 * 4 + 1];
      const m32 = m[3 * 4 + 2];
      const m33 = m[3 * 4 + 3];
      newDst[0] = m00;
      newDst[1] = m10;
      newDst[2] = m20;
      newDst[3] = m30;
      newDst[4] = m01;
      newDst[5] = m11;
      newDst[6] = m21;
      newDst[7] = m31;
      newDst[8] = m02;
      newDst[9] = m12;
      newDst[10] = m22;
      newDst[11] = m32;
      newDst[12] = m03;
      newDst[13] = m13;
      newDst[14] = m23;
      newDst[15] = m33;
      return newDst;
    }
    function inverse(m, dst) {
      const newDst = dst ?? new Ctor(16);
      const m00 = m[0 * 4 + 0];
      const m01 = m[0 * 4 + 1];
      const m02 = m[0 * 4 + 2];
      const m03 = m[0 * 4 + 3];
      const m10 = m[1 * 4 + 0];
      const m11 = m[1 * 4 + 1];
      const m12 = m[1 * 4 + 2];
      const m13 = m[1 * 4 + 3];
      const m20 = m[2 * 4 + 0];
      const m21 = m[2 * 4 + 1];
      const m22 = m[2 * 4 + 2];
      const m23 = m[2 * 4 + 3];
      const m30 = m[3 * 4 + 0];
      const m31 = m[3 * 4 + 1];
      const m32 = m[3 * 4 + 2];
      const m33 = m[3 * 4 + 3];
      const tmp0 = m22 * m33;
      const tmp1 = m32 * m23;
      const tmp2 = m12 * m33;
      const tmp3 = m32 * m13;
      const tmp4 = m12 * m23;
      const tmp5 = m22 * m13;
      const tmp6 = m02 * m33;
      const tmp7 = m32 * m03;
      const tmp8 = m02 * m23;
      const tmp9 = m22 * m03;
      const tmp10 = m02 * m13;
      const tmp11 = m12 * m03;
      const tmp12 = m20 * m31;
      const tmp13 = m30 * m21;
      const tmp14 = m10 * m31;
      const tmp15 = m30 * m11;
      const tmp16 = m10 * m21;
      const tmp17 = m20 * m11;
      const tmp18 = m00 * m31;
      const tmp19 = m30 * m01;
      const tmp20 = m00 * m21;
      const tmp21 = m20 * m01;
      const tmp22 = m00 * m11;
      const tmp23 = m10 * m01;
      const t0 = tmp0 * m11 + tmp3 * m21 + tmp4 * m31 - (tmp1 * m11 + tmp2 * m21 + tmp5 * m31);
      const t1 = tmp1 * m01 + tmp6 * m21 + tmp9 * m31 - (tmp0 * m01 + tmp7 * m21 + tmp8 * m31);
      const t2 = tmp2 * m01 + tmp7 * m11 + tmp10 * m31 - (tmp3 * m01 + tmp6 * m11 + tmp11 * m31);
      const t3 = tmp5 * m01 + tmp8 * m11 + tmp11 * m21 - (tmp4 * m01 + tmp9 * m11 + tmp10 * m21);
      const d = 1 / (m00 * t0 + m10 * t1 + m20 * t2 + m30 * t3);
      newDst[0] = d * t0;
      newDst[1] = d * t1;
      newDst[2] = d * t2;
      newDst[3] = d * t3;
      newDst[4] = d * (tmp1 * m10 + tmp2 * m20 + tmp5 * m30 - (tmp0 * m10 + tmp3 * m20 + tmp4 * m30));
      newDst[5] = d * (tmp0 * m00 + tmp7 * m20 + tmp8 * m30 - (tmp1 * m00 + tmp6 * m20 + tmp9 * m30));
      newDst[6] = d * (tmp3 * m00 + tmp6 * m10 + tmp11 * m30 - (tmp2 * m00 + tmp7 * m10 + tmp10 * m30));
      newDst[7] = d * (tmp4 * m00 + tmp9 * m10 + tmp10 * m20 - (tmp5 * m00 + tmp8 * m10 + tmp11 * m20));
      newDst[8] = d * (tmp12 * m13 + tmp15 * m23 + tmp16 * m33 - (tmp13 * m13 + tmp14 * m23 + tmp17 * m33));
      newDst[9] = d * (tmp13 * m03 + tmp18 * m23 + tmp21 * m33 - (tmp12 * m03 + tmp19 * m23 + tmp20 * m33));
      newDst[10] = d * (tmp14 * m03 + tmp19 * m13 + tmp22 * m33 - (tmp15 * m03 + tmp18 * m13 + tmp23 * m33));
      newDst[11] = d * (tmp17 * m03 + tmp20 * m13 + tmp23 * m23 - (tmp16 * m03 + tmp21 * m13 + tmp22 * m23));
      newDst[12] = d * (tmp14 * m22 + tmp17 * m32 + tmp13 * m12 - (tmp16 * m32 + tmp12 * m12 + tmp15 * m22));
      newDst[13] = d * (tmp20 * m32 + tmp12 * m02 + tmp19 * m22 - (tmp18 * m22 + tmp21 * m32 + tmp13 * m02));
      newDst[14] = d * (tmp18 * m12 + tmp23 * m32 + tmp15 * m02 - (tmp22 * m32 + tmp14 * m02 + tmp19 * m12));
      newDst[15] = d * (tmp22 * m22 + tmp16 * m02 + tmp21 * m12 - (tmp20 * m12 + tmp23 * m22 + tmp17 * m02));
      return newDst;
    }
    function determinant(m) {
      const m00 = m[0 * 4 + 0];
      const m01 = m[0 * 4 + 1];
      const m02 = m[0 * 4 + 2];
      const m03 = m[0 * 4 + 3];
      const m10 = m[1 * 4 + 0];
      const m11 = m[1 * 4 + 1];
      const m12 = m[1 * 4 + 2];
      const m13 = m[1 * 4 + 3];
      const m20 = m[2 * 4 + 0];
      const m21 = m[2 * 4 + 1];
      const m22 = m[2 * 4 + 2];
      const m23 = m[2 * 4 + 3];
      const m30 = m[3 * 4 + 0];
      const m31 = m[3 * 4 + 1];
      const m32 = m[3 * 4 + 2];
      const m33 = m[3 * 4 + 3];
      const tmp0 = m22 * m33;
      const tmp1 = m32 * m23;
      const tmp2 = m12 * m33;
      const tmp3 = m32 * m13;
      const tmp4 = m12 * m23;
      const tmp5 = m22 * m13;
      const tmp6 = m02 * m33;
      const tmp7 = m32 * m03;
      const tmp8 = m02 * m23;
      const tmp9 = m22 * m03;
      const tmp10 = m02 * m13;
      const tmp11 = m12 * m03;
      const t0 = tmp0 * m11 + tmp3 * m21 + tmp4 * m31 - (tmp1 * m11 + tmp2 * m21 + tmp5 * m31);
      const t1 = tmp1 * m01 + tmp6 * m21 + tmp9 * m31 - (tmp0 * m01 + tmp7 * m21 + tmp8 * m31);
      const t2 = tmp2 * m01 + tmp7 * m11 + tmp10 * m31 - (tmp3 * m01 + tmp6 * m11 + tmp11 * m31);
      const t3 = tmp5 * m01 + tmp8 * m11 + tmp11 * m21 - (tmp4 * m01 + tmp9 * m11 + tmp10 * m21);
      return m00 * t0 + m10 * t1 + m20 * t2 + m30 * t3;
    }
    const invert = inverse;
    function multiply(a, b, dst) {
      const newDst = dst ?? new Ctor(16);
      const a00 = a[0];
      const a01 = a[1];
      const a02 = a[2];
      const a03 = a[3];
      const a10 = a[4 + 0];
      const a11 = a[4 + 1];
      const a12 = a[4 + 2];
      const a13 = a[4 + 3];
      const a20 = a[8 + 0];
      const a21 = a[8 + 1];
      const a22 = a[8 + 2];
      const a23 = a[8 + 3];
      const a30 = a[12 + 0];
      const a31 = a[12 + 1];
      const a32 = a[12 + 2];
      const a33 = a[12 + 3];
      const b00 = b[0];
      const b01 = b[1];
      const b02 = b[2];
      const b03 = b[3];
      const b10 = b[4 + 0];
      const b11 = b[4 + 1];
      const b12 = b[4 + 2];
      const b13 = b[4 + 3];
      const b20 = b[8 + 0];
      const b21 = b[8 + 1];
      const b22 = b[8 + 2];
      const b23 = b[8 + 3];
      const b30 = b[12 + 0];
      const b31 = b[12 + 1];
      const b32 = b[12 + 2];
      const b33 = b[12 + 3];
      newDst[0] = a00 * b00 + a10 * b01 + a20 * b02 + a30 * b03;
      newDst[1] = a01 * b00 + a11 * b01 + a21 * b02 + a31 * b03;
      newDst[2] = a02 * b00 + a12 * b01 + a22 * b02 + a32 * b03;
      newDst[3] = a03 * b00 + a13 * b01 + a23 * b02 + a33 * b03;
      newDst[4] = a00 * b10 + a10 * b11 + a20 * b12 + a30 * b13;
      newDst[5] = a01 * b10 + a11 * b11 + a21 * b12 + a31 * b13;
      newDst[6] = a02 * b10 + a12 * b11 + a22 * b12 + a32 * b13;
      newDst[7] = a03 * b10 + a13 * b11 + a23 * b12 + a33 * b13;
      newDst[8] = a00 * b20 + a10 * b21 + a20 * b22 + a30 * b23;
      newDst[9] = a01 * b20 + a11 * b21 + a21 * b22 + a31 * b23;
      newDst[10] = a02 * b20 + a12 * b21 + a22 * b22 + a32 * b23;
      newDst[11] = a03 * b20 + a13 * b21 + a23 * b22 + a33 * b23;
      newDst[12] = a00 * b30 + a10 * b31 + a20 * b32 + a30 * b33;
      newDst[13] = a01 * b30 + a11 * b31 + a21 * b32 + a31 * b33;
      newDst[14] = a02 * b30 + a12 * b31 + a22 * b32 + a32 * b33;
      newDst[15] = a03 * b30 + a13 * b31 + a23 * b32 + a33 * b33;
      return newDst;
    }
    const mul = multiply;
    function setTranslation(a, v, dst) {
      const newDst = dst ?? identity();
      if (a !== newDst) {
        newDst[0] = a[0];
        newDst[1] = a[1];
        newDst[2] = a[2];
        newDst[3] = a[3];
        newDst[4] = a[4];
        newDst[5] = a[5];
        newDst[6] = a[6];
        newDst[7] = a[7];
        newDst[8] = a[8];
        newDst[9] = a[9];
        newDst[10] = a[10];
        newDst[11] = a[11];
      }
      newDst[12] = v[0];
      newDst[13] = v[1];
      newDst[14] = v[2];
      newDst[15] = 1;
      return newDst;
    }
    function getTranslation(m, dst) {
      const newDst = dst ?? vec32.create();
      newDst[0] = m[12];
      newDst[1] = m[13];
      newDst[2] = m[14];
      return newDst;
    }
    function getAxis(m, axis, dst) {
      const newDst = dst ?? vec32.create();
      const off = axis * 4;
      newDst[0] = m[off + 0];
      newDst[1] = m[off + 1];
      newDst[2] = m[off + 2];
      return newDst;
    }
    function setAxis(m, v, axis, dst) {
      const newDst = dst === m ? dst : copy(m, dst);
      const off = axis * 4;
      newDst[off + 0] = v[0];
      newDst[off + 1] = v[1];
      newDst[off + 2] = v[2];
      return newDst;
    }
    function getScaling(m, dst) {
      const newDst = dst ?? vec32.create();
      const xx = m[0];
      const xy = m[1];
      const xz = m[2];
      const yx = m[4];
      const yy = m[5];
      const yz = m[6];
      const zx = m[8];
      const zy = m[9];
      const zz = m[10];
      newDst[0] = Math.sqrt(xx * xx + xy * xy + xz * xz);
      newDst[1] = Math.sqrt(yx * yx + yy * yy + yz * yz);
      newDst[2] = Math.sqrt(zx * zx + zy * zy + zz * zz);
      return newDst;
    }
    function perspective(fieldOfViewYInRadians, aspect, zNear, zFar, dst) {
      const newDst = dst ?? new Ctor(16);
      const f = Math.tan(Math.PI * 0.5 - 0.5 * fieldOfViewYInRadians);
      newDst[0] = f / aspect;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = f;
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[11] = -1;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[15] = 0;
      if (Number.isFinite(zFar)) {
        const rangeInv = 1 / (zNear - zFar);
        newDst[10] = zFar * rangeInv;
        newDst[14] = zFar * zNear * rangeInv;
      } else {
        newDst[10] = -1;
        newDst[14] = -zNear;
      }
      return newDst;
    }
    function perspectiveReverseZ(fieldOfViewYInRadians, aspect, zNear, zFar = Infinity, dst) {
      const newDst = dst ?? new Ctor(16);
      const f = 1 / Math.tan(fieldOfViewYInRadians * 0.5);
      newDst[0] = f / aspect;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = f;
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[11] = -1;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[15] = 0;
      if (zFar === Infinity) {
        newDst[10] = 0;
        newDst[14] = zNear;
      } else {
        const rangeInv = 1 / (zFar - zNear);
        newDst[10] = zNear * rangeInv;
        newDst[14] = zFar * zNear * rangeInv;
      }
      return newDst;
    }
    function ortho(left, right, bottom, top, near, far, dst) {
      const newDst = dst ?? new Ctor(16);
      newDst[0] = 2 / (right - left);
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = 2 / (top - bottom);
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[10] = 1 / (near - far);
      newDst[11] = 0;
      newDst[12] = (right + left) / (left - right);
      newDst[13] = (top + bottom) / (bottom - top);
      newDst[14] = near / (near - far);
      newDst[15] = 1;
      return newDst;
    }
    function frustum(left, right, bottom, top, near, far, dst) {
      const newDst = dst ?? new Ctor(16);
      const dx = right - left;
      const dy = top - bottom;
      const dz = near - far;
      newDst[0] = 2 * near / dx;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = 2 * near / dy;
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = (left + right) / dx;
      newDst[9] = (top + bottom) / dy;
      newDst[10] = far / dz;
      newDst[11] = -1;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[14] = near * far / dz;
      newDst[15] = 0;
      return newDst;
    }
    function frustumReverseZ(left, right, bottom, top, near, far = Infinity, dst) {
      const newDst = dst ?? new Ctor(16);
      const dx = right - left;
      const dy = top - bottom;
      newDst[0] = 2 * near / dx;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = 2 * near / dy;
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = (left + right) / dx;
      newDst[9] = (top + bottom) / dy;
      newDst[11] = -1;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[15] = 0;
      if (far === Infinity) {
        newDst[10] = 0;
        newDst[14] = near;
      } else {
        const rangeInv = 1 / (far - near);
        newDst[10] = near * rangeInv;
        newDst[14] = far * near * rangeInv;
      }
      return newDst;
    }
    const xAxis = vec32.create();
    const yAxis = vec32.create();
    const zAxis = vec32.create();
    function aim(position, target, up, dst) {
      const newDst = dst ?? new Ctor(16);
      vec32.normalize(vec32.subtract(target, position, zAxis), zAxis);
      vec32.normalize(vec32.cross(up, zAxis, xAxis), xAxis);
      vec32.normalize(vec32.cross(zAxis, xAxis, yAxis), yAxis);
      newDst[0] = xAxis[0];
      newDst[1] = xAxis[1];
      newDst[2] = xAxis[2];
      newDst[3] = 0;
      newDst[4] = yAxis[0];
      newDst[5] = yAxis[1];
      newDst[6] = yAxis[2];
      newDst[7] = 0;
      newDst[8] = zAxis[0];
      newDst[9] = zAxis[1];
      newDst[10] = zAxis[2];
      newDst[11] = 0;
      newDst[12] = position[0];
      newDst[13] = position[1];
      newDst[14] = position[2];
      newDst[15] = 1;
      return newDst;
    }
    function cameraAim(eye, target, up, dst) {
      const newDst = dst ?? new Ctor(16);
      vec32.normalize(vec32.subtract(eye, target, zAxis), zAxis);
      vec32.normalize(vec32.cross(up, zAxis, xAxis), xAxis);
      vec32.normalize(vec32.cross(zAxis, xAxis, yAxis), yAxis);
      newDst[0] = xAxis[0];
      newDst[1] = xAxis[1];
      newDst[2] = xAxis[2];
      newDst[3] = 0;
      newDst[4] = yAxis[0];
      newDst[5] = yAxis[1];
      newDst[6] = yAxis[2];
      newDst[7] = 0;
      newDst[8] = zAxis[0];
      newDst[9] = zAxis[1];
      newDst[10] = zAxis[2];
      newDst[11] = 0;
      newDst[12] = eye[0];
      newDst[13] = eye[1];
      newDst[14] = eye[2];
      newDst[15] = 1;
      return newDst;
    }
    function lookAt(eye, target, up, dst) {
      const newDst = dst ?? new Ctor(16);
      vec32.normalize(vec32.subtract(eye, target, zAxis), zAxis);
      vec32.normalize(vec32.cross(up, zAxis, xAxis), xAxis);
      vec32.normalize(vec32.cross(zAxis, xAxis, yAxis), yAxis);
      newDst[0] = xAxis[0];
      newDst[1] = yAxis[0];
      newDst[2] = zAxis[0];
      newDst[3] = 0;
      newDst[4] = xAxis[1];
      newDst[5] = yAxis[1];
      newDst[6] = zAxis[1];
      newDst[7] = 0;
      newDst[8] = xAxis[2];
      newDst[9] = yAxis[2];
      newDst[10] = zAxis[2];
      newDst[11] = 0;
      newDst[12] = -(xAxis[0] * eye[0] + xAxis[1] * eye[1] + xAxis[2] * eye[2]);
      newDst[13] = -(yAxis[0] * eye[0] + yAxis[1] * eye[1] + yAxis[2] * eye[2]);
      newDst[14] = -(zAxis[0] * eye[0] + zAxis[1] * eye[1] + zAxis[2] * eye[2]);
      newDst[15] = 1;
      return newDst;
    }
    function translation(v, dst) {
      const newDst = dst ?? new Ctor(16);
      newDst[0] = 1;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = 1;
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[10] = 1;
      newDst[11] = 0;
      newDst[12] = v[0];
      newDst[13] = v[1];
      newDst[14] = v[2];
      newDst[15] = 1;
      return newDst;
    }
    function translate(m, v, dst) {
      const newDst = dst ?? new Ctor(16);
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      const m00 = m[0];
      const m01 = m[1];
      const m02 = m[2];
      const m03 = m[3];
      const m10 = m[1 * 4 + 0];
      const m11 = m[1 * 4 + 1];
      const m12 = m[1 * 4 + 2];
      const m13 = m[1 * 4 + 3];
      const m20 = m[2 * 4 + 0];
      const m21 = m[2 * 4 + 1];
      const m22 = m[2 * 4 + 2];
      const m23 = m[2 * 4 + 3];
      const m30 = m[3 * 4 + 0];
      const m31 = m[3 * 4 + 1];
      const m32 = m[3 * 4 + 2];
      const m33 = m[3 * 4 + 3];
      if (m !== newDst) {
        newDst[0] = m00;
        newDst[1] = m01;
        newDst[2] = m02;
        newDst[3] = m03;
        newDst[4] = m10;
        newDst[5] = m11;
        newDst[6] = m12;
        newDst[7] = m13;
        newDst[8] = m20;
        newDst[9] = m21;
        newDst[10] = m22;
        newDst[11] = m23;
      }
      newDst[12] = m00 * v0 + m10 * v1 + m20 * v2 + m30;
      newDst[13] = m01 * v0 + m11 * v1 + m21 * v2 + m31;
      newDst[14] = m02 * v0 + m12 * v1 + m22 * v2 + m32;
      newDst[15] = m03 * v0 + m13 * v1 + m23 * v2 + m33;
      return newDst;
    }
    function rotationX(angleInRadians, dst) {
      const newDst = dst ?? new Ctor(16);
      const c = Math.cos(angleInRadians);
      const s = Math.sin(angleInRadians);
      newDst[0] = 1;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = c;
      newDst[6] = s;
      newDst[7] = 0;
      newDst[8] = 0;
      newDst[9] = -s;
      newDst[10] = c;
      newDst[11] = 0;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[14] = 0;
      newDst[15] = 1;
      return newDst;
    }
    function rotateX(m, angleInRadians, dst) {
      const newDst = dst ?? new Ctor(16);
      const m10 = m[4];
      const m11 = m[5];
      const m12 = m[6];
      const m13 = m[7];
      const m20 = m[8];
      const m21 = m[9];
      const m22 = m[10];
      const m23 = m[11];
      const c = Math.cos(angleInRadians);
      const s = Math.sin(angleInRadians);
      newDst[4] = c * m10 + s * m20;
      newDst[5] = c * m11 + s * m21;
      newDst[6] = c * m12 + s * m22;
      newDst[7] = c * m13 + s * m23;
      newDst[8] = c * m20 - s * m10;
      newDst[9] = c * m21 - s * m11;
      newDst[10] = c * m22 - s * m12;
      newDst[11] = c * m23 - s * m13;
      if (m !== newDst) {
        newDst[0] = m[0];
        newDst[1] = m[1];
        newDst[2] = m[2];
        newDst[3] = m[3];
        newDst[12] = m[12];
        newDst[13] = m[13];
        newDst[14] = m[14];
        newDst[15] = m[15];
      }
      return newDst;
    }
    function rotationY(angleInRadians, dst) {
      const newDst = dst ?? new Ctor(16);
      const c = Math.cos(angleInRadians);
      const s = Math.sin(angleInRadians);
      newDst[0] = c;
      newDst[1] = 0;
      newDst[2] = -s;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = 1;
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = s;
      newDst[9] = 0;
      newDst[10] = c;
      newDst[11] = 0;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[14] = 0;
      newDst[15] = 1;
      return newDst;
    }
    function rotateY(m, angleInRadians, dst) {
      const newDst = dst ?? new Ctor(16);
      const m00 = m[0 * 4 + 0];
      const m01 = m[0 * 4 + 1];
      const m02 = m[0 * 4 + 2];
      const m03 = m[0 * 4 + 3];
      const m20 = m[2 * 4 + 0];
      const m21 = m[2 * 4 + 1];
      const m22 = m[2 * 4 + 2];
      const m23 = m[2 * 4 + 3];
      const c = Math.cos(angleInRadians);
      const s = Math.sin(angleInRadians);
      newDst[0] = c * m00 - s * m20;
      newDst[1] = c * m01 - s * m21;
      newDst[2] = c * m02 - s * m22;
      newDst[3] = c * m03 - s * m23;
      newDst[8] = c * m20 + s * m00;
      newDst[9] = c * m21 + s * m01;
      newDst[10] = c * m22 + s * m02;
      newDst[11] = c * m23 + s * m03;
      if (m !== newDst) {
        newDst[4] = m[4];
        newDst[5] = m[5];
        newDst[6] = m[6];
        newDst[7] = m[7];
        newDst[12] = m[12];
        newDst[13] = m[13];
        newDst[14] = m[14];
        newDst[15] = m[15];
      }
      return newDst;
    }
    function rotationZ(angleInRadians, dst) {
      const newDst = dst ?? new Ctor(16);
      const c = Math.cos(angleInRadians);
      const s = Math.sin(angleInRadians);
      newDst[0] = c;
      newDst[1] = s;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = -s;
      newDst[5] = c;
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[10] = 1;
      newDst[11] = 0;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[14] = 0;
      newDst[15] = 1;
      return newDst;
    }
    function rotateZ(m, angleInRadians, dst) {
      const newDst = dst ?? new Ctor(16);
      const m00 = m[0 * 4 + 0];
      const m01 = m[0 * 4 + 1];
      const m02 = m[0 * 4 + 2];
      const m03 = m[0 * 4 + 3];
      const m10 = m[1 * 4 + 0];
      const m11 = m[1 * 4 + 1];
      const m12 = m[1 * 4 + 2];
      const m13 = m[1 * 4 + 3];
      const c = Math.cos(angleInRadians);
      const s = Math.sin(angleInRadians);
      newDst[0] = c * m00 + s * m10;
      newDst[1] = c * m01 + s * m11;
      newDst[2] = c * m02 + s * m12;
      newDst[3] = c * m03 + s * m13;
      newDst[4] = c * m10 - s * m00;
      newDst[5] = c * m11 - s * m01;
      newDst[6] = c * m12 - s * m02;
      newDst[7] = c * m13 - s * m03;
      if (m !== newDst) {
        newDst[8] = m[8];
        newDst[9] = m[9];
        newDst[10] = m[10];
        newDst[11] = m[11];
        newDst[12] = m[12];
        newDst[13] = m[13];
        newDst[14] = m[14];
        newDst[15] = m[15];
      }
      return newDst;
    }
    function axisRotation(axis, angleInRadians, dst) {
      const newDst = dst ?? new Ctor(16);
      let x = axis[0];
      let y = axis[1];
      let z = axis[2];
      const n = Math.sqrt(x * x + y * y + z * z);
      x /= n;
      y /= n;
      z /= n;
      const xx = x * x;
      const yy = y * y;
      const zz = z * z;
      const c = Math.cos(angleInRadians);
      const s = Math.sin(angleInRadians);
      const oneMinusCosine = 1 - c;
      newDst[0] = xx + (1 - xx) * c;
      newDst[1] = x * y * oneMinusCosine + z * s;
      newDst[2] = x * z * oneMinusCosine - y * s;
      newDst[3] = 0;
      newDst[4] = x * y * oneMinusCosine - z * s;
      newDst[5] = yy + (1 - yy) * c;
      newDst[6] = y * z * oneMinusCosine + x * s;
      newDst[7] = 0;
      newDst[8] = x * z * oneMinusCosine + y * s;
      newDst[9] = y * z * oneMinusCosine - x * s;
      newDst[10] = zz + (1 - zz) * c;
      newDst[11] = 0;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[14] = 0;
      newDst[15] = 1;
      return newDst;
    }
    const rotation = axisRotation;
    function axisRotate(m, axis, angleInRadians, dst) {
      const newDst = dst ?? new Ctor(16);
      let x = axis[0];
      let y = axis[1];
      let z = axis[2];
      const n = Math.sqrt(x * x + y * y + z * z);
      x /= n;
      y /= n;
      z /= n;
      const xx = x * x;
      const yy = y * y;
      const zz = z * z;
      const c = Math.cos(angleInRadians);
      const s = Math.sin(angleInRadians);
      const oneMinusCosine = 1 - c;
      const r00 = xx + (1 - xx) * c;
      const r01 = x * y * oneMinusCosine + z * s;
      const r02 = x * z * oneMinusCosine - y * s;
      const r10 = x * y * oneMinusCosine - z * s;
      const r11 = yy + (1 - yy) * c;
      const r12 = y * z * oneMinusCosine + x * s;
      const r20 = x * z * oneMinusCosine + y * s;
      const r21 = y * z * oneMinusCosine - x * s;
      const r22 = zz + (1 - zz) * c;
      const m00 = m[0];
      const m01 = m[1];
      const m02 = m[2];
      const m03 = m[3];
      const m10 = m[4];
      const m11 = m[5];
      const m12 = m[6];
      const m13 = m[7];
      const m20 = m[8];
      const m21 = m[9];
      const m22 = m[10];
      const m23 = m[11];
      newDst[0] = r00 * m00 + r01 * m10 + r02 * m20;
      newDst[1] = r00 * m01 + r01 * m11 + r02 * m21;
      newDst[2] = r00 * m02 + r01 * m12 + r02 * m22;
      newDst[3] = r00 * m03 + r01 * m13 + r02 * m23;
      newDst[4] = r10 * m00 + r11 * m10 + r12 * m20;
      newDst[5] = r10 * m01 + r11 * m11 + r12 * m21;
      newDst[6] = r10 * m02 + r11 * m12 + r12 * m22;
      newDst[7] = r10 * m03 + r11 * m13 + r12 * m23;
      newDst[8] = r20 * m00 + r21 * m10 + r22 * m20;
      newDst[9] = r20 * m01 + r21 * m11 + r22 * m21;
      newDst[10] = r20 * m02 + r21 * m12 + r22 * m22;
      newDst[11] = r20 * m03 + r21 * m13 + r22 * m23;
      if (m !== newDst) {
        newDst[12] = m[12];
        newDst[13] = m[13];
        newDst[14] = m[14];
        newDst[15] = m[15];
      }
      return newDst;
    }
    const rotate = axisRotate;
    function scaling(v, dst) {
      const newDst = dst ?? new Ctor(16);
      newDst[0] = v[0];
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = v[1];
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[10] = v[2];
      newDst[11] = 0;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[14] = 0;
      newDst[15] = 1;
      return newDst;
    }
    function scale(m, v, dst) {
      const newDst = dst ?? new Ctor(16);
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      newDst[0] = v0 * m[0 * 4 + 0];
      newDst[1] = v0 * m[0 * 4 + 1];
      newDst[2] = v0 * m[0 * 4 + 2];
      newDst[3] = v0 * m[0 * 4 + 3];
      newDst[4] = v1 * m[1 * 4 + 0];
      newDst[5] = v1 * m[1 * 4 + 1];
      newDst[6] = v1 * m[1 * 4 + 2];
      newDst[7] = v1 * m[1 * 4 + 3];
      newDst[8] = v2 * m[2 * 4 + 0];
      newDst[9] = v2 * m[2 * 4 + 1];
      newDst[10] = v2 * m[2 * 4 + 2];
      newDst[11] = v2 * m[2 * 4 + 3];
      if (m !== newDst) {
        newDst[12] = m[12];
        newDst[13] = m[13];
        newDst[14] = m[14];
        newDst[15] = m[15];
      }
      return newDst;
    }
    function uniformScaling(s, dst) {
      const newDst = dst ?? new Ctor(16);
      newDst[0] = s;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      newDst[4] = 0;
      newDst[5] = s;
      newDst[6] = 0;
      newDst[7] = 0;
      newDst[8] = 0;
      newDst[9] = 0;
      newDst[10] = s;
      newDst[11] = 0;
      newDst[12] = 0;
      newDst[13] = 0;
      newDst[14] = 0;
      newDst[15] = 1;
      return newDst;
    }
    function uniformScale(m, s, dst) {
      const newDst = dst ?? new Ctor(16);
      newDst[0] = s * m[0 * 4 + 0];
      newDst[1] = s * m[0 * 4 + 1];
      newDst[2] = s * m[0 * 4 + 2];
      newDst[3] = s * m[0 * 4 + 3];
      newDst[4] = s * m[1 * 4 + 0];
      newDst[5] = s * m[1 * 4 + 1];
      newDst[6] = s * m[1 * 4 + 2];
      newDst[7] = s * m[1 * 4 + 3];
      newDst[8] = s * m[2 * 4 + 0];
      newDst[9] = s * m[2 * 4 + 1];
      newDst[10] = s * m[2 * 4 + 2];
      newDst[11] = s * m[2 * 4 + 3];
      if (m !== newDst) {
        newDst[12] = m[12];
        newDst[13] = m[13];
        newDst[14] = m[14];
        newDst[15] = m[15];
      }
      return newDst;
    }
    return {
      create,
      set,
      fromMat3,
      fromQuat,
      negate,
      copy,
      clone,
      equalsApproximately,
      equals,
      identity,
      transpose,
      inverse,
      determinant,
      invert,
      multiply,
      mul,
      setTranslation,
      getTranslation,
      getAxis,
      setAxis,
      getScaling,
      perspective,
      perspectiveReverseZ,
      ortho,
      frustum,
      frustumReverseZ,
      aim,
      cameraAim,
      lookAt,
      translation,
      translate,
      rotationX,
      rotateX,
      rotationY,
      rotateY,
      rotationZ,
      rotateZ,
      axisRotation,
      rotation,
      axisRotate,
      rotate,
      scaling,
      scale,
      uniformScaling,
      uniformScale
    };
  }
  var cache$2 = /* @__PURE__ */ new Map();
  function getAPI$2(Ctor) {
    let api = cache$2.get(Ctor);
    if (!api) {
      api = getAPIImpl$2(Ctor);
      cache$2.set(Ctor, api);
    }
    return api;
  }
  function getAPIImpl$1(Ctor) {
    const vec32 = getAPI$3(Ctor);
    function create(x, y, z, w) {
      const newDst = new Ctor(4);
      if (x !== void 0) {
        newDst[0] = x;
        if (y !== void 0) {
          newDst[1] = y;
          if (z !== void 0) {
            newDst[2] = z;
            if (w !== void 0) {
              newDst[3] = w;
            }
          }
        }
      }
      return newDst;
    }
    const fromValues = create;
    function set(x, y, z, w, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = x;
      newDst[1] = y;
      newDst[2] = z;
      newDst[3] = w;
      return newDst;
    }
    function fromAxisAngle(axis, angleInRadians, dst) {
      const newDst = dst ?? new Ctor(4);
      const halfAngle = angleInRadians * 0.5;
      const s = Math.sin(halfAngle);
      newDst[0] = s * axis[0];
      newDst[1] = s * axis[1];
      newDst[2] = s * axis[2];
      newDst[3] = Math.cos(halfAngle);
      return newDst;
    }
    function toAxisAngle(q, dst) {
      const newDst = dst ?? vec32.create(3);
      const angle2 = Math.acos(q[3]) * 2;
      const s = Math.sin(angle2 * 0.5);
      if (s > EPSILON) {
        newDst[0] = q[0] / s;
        newDst[1] = q[1] / s;
        newDst[2] = q[2] / s;
      } else {
        newDst[0] = 1;
        newDst[1] = 0;
        newDst[2] = 0;
      }
      return { angle: angle2, axis: newDst };
    }
    function angle(a, b) {
      const d = dot(a, b);
      return Math.acos(2 * d * d - 1);
    }
    function multiply(a, b, dst) {
      const newDst = dst ?? new Ctor(4);
      const ax = a[0];
      const ay = a[1];
      const az = a[2];
      const aw = a[3];
      const bx = b[0];
      const by = b[1];
      const bz = b[2];
      const bw = b[3];
      newDst[0] = ax * bw + aw * bx + ay * bz - az * by;
      newDst[1] = ay * bw + aw * by + az * bx - ax * bz;
      newDst[2] = az * bw + aw * bz + ax * by - ay * bx;
      newDst[3] = aw * bw - ax * bx - ay * by - az * bz;
      return newDst;
    }
    const mul = multiply;
    function rotateX(q, angleInRadians, dst) {
      const newDst = dst ?? new Ctor(4);
      const halfAngle = angleInRadians * 0.5;
      const qx = q[0];
      const qy = q[1];
      const qz = q[2];
      const qw = q[3];
      const bx = Math.sin(halfAngle);
      const bw = Math.cos(halfAngle);
      newDst[0] = qx * bw + qw * bx;
      newDst[1] = qy * bw + qz * bx;
      newDst[2] = qz * bw - qy * bx;
      newDst[3] = qw * bw - qx * bx;
      return newDst;
    }
    function rotateY(q, angleInRadians, dst) {
      const newDst = dst ?? new Ctor(4);
      const halfAngle = angleInRadians * 0.5;
      const qx = q[0];
      const qy = q[1];
      const qz = q[2];
      const qw = q[3];
      const by = Math.sin(halfAngle);
      const bw = Math.cos(halfAngle);
      newDst[0] = qx * bw - qz * by;
      newDst[1] = qy * bw + qw * by;
      newDst[2] = qz * bw + qx * by;
      newDst[3] = qw * bw - qy * by;
      return newDst;
    }
    function rotateZ(q, angleInRadians, dst) {
      const newDst = dst ?? new Ctor(4);
      const halfAngle = angleInRadians * 0.5;
      const qx = q[0];
      const qy = q[1];
      const qz = q[2];
      const qw = q[3];
      const bz = Math.sin(halfAngle);
      const bw = Math.cos(halfAngle);
      newDst[0] = qx * bw + qy * bz;
      newDst[1] = qy * bw - qx * bz;
      newDst[2] = qz * bw + qw * bz;
      newDst[3] = qw * bw - qz * bz;
      return newDst;
    }
    function slerp(a, b, t, dst) {
      const newDst = dst ?? new Ctor(4);
      const ax = a[0];
      const ay = a[1];
      const az = a[2];
      const aw = a[3];
      let bx = b[0];
      let by = b[1];
      let bz = b[2];
      let bw = b[3];
      let cosOmega = ax * bx + ay * by + az * bz + aw * bw;
      if (cosOmega < 0) {
        cosOmega = -cosOmega;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
      }
      let scale0;
      let scale1;
      if (1 - cosOmega > EPSILON) {
        const omega = Math.acos(cosOmega);
        const sinOmega = Math.sin(omega);
        scale0 = Math.sin((1 - t) * omega) / sinOmega;
        scale1 = Math.sin(t * omega) / sinOmega;
      } else {
        scale0 = 1 - t;
        scale1 = t;
      }
      newDst[0] = scale0 * ax + scale1 * bx;
      newDst[1] = scale0 * ay + scale1 * by;
      newDst[2] = scale0 * az + scale1 * bz;
      newDst[3] = scale0 * aw + scale1 * bw;
      return newDst;
    }
    function inverse(q, dst) {
      const newDst = dst ?? new Ctor(4);
      const a0 = q[0];
      const a1 = q[1];
      const a2 = q[2];
      const a3 = q[3];
      const dot2 = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
      const invDot = dot2 ? 1 / dot2 : 0;
      newDst[0] = -a0 * invDot;
      newDst[1] = -a1 * invDot;
      newDst[2] = -a2 * invDot;
      newDst[3] = a3 * invDot;
      return newDst;
    }
    function conjugate(q, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = -q[0];
      newDst[1] = -q[1];
      newDst[2] = -q[2];
      newDst[3] = q[3];
      return newDst;
    }
    function fromMat(m, dst) {
      const newDst = dst ?? new Ctor(4);
      const trace = m[0] + m[5] + m[10];
      if (trace > 0) {
        const root = Math.sqrt(trace + 1);
        newDst[3] = 0.5 * root;
        const invRoot = 0.5 / root;
        newDst[0] = (m[6] - m[9]) * invRoot;
        newDst[1] = (m[8] - m[2]) * invRoot;
        newDst[2] = (m[1] - m[4]) * invRoot;
      } else {
        let i = 0;
        if (m[5] > m[0]) {
          i = 1;
        }
        if (m[10] > m[i * 4 + i]) {
          i = 2;
        }
        const j = (i + 1) % 3;
        const k = (i + 2) % 3;
        const root = Math.sqrt(m[i * 4 + i] - m[j * 4 + j] - m[k * 4 + k] + 1);
        newDst[i] = 0.5 * root;
        const invRoot = 0.5 / root;
        newDst[3] = (m[j * 4 + k] - m[k * 4 + j]) * invRoot;
        newDst[j] = (m[j * 4 + i] + m[i * 4 + j]) * invRoot;
        newDst[k] = (m[k * 4 + i] + m[i * 4 + k]) * invRoot;
      }
      return newDst;
    }
    function fromEuler(xAngleInRadians, yAngleInRadians, zAngleInRadians, order, dst) {
      const newDst = dst ?? new Ctor(4);
      const xHalfAngle = xAngleInRadians * 0.5;
      const yHalfAngle = yAngleInRadians * 0.5;
      const zHalfAngle = zAngleInRadians * 0.5;
      const sx = Math.sin(xHalfAngle);
      const cx = Math.cos(xHalfAngle);
      const sy = Math.sin(yHalfAngle);
      const cy = Math.cos(yHalfAngle);
      const sz = Math.sin(zHalfAngle);
      const cz = Math.cos(zHalfAngle);
      switch (order) {
        case "xyz":
          newDst[0] = sx * cy * cz + cx * sy * sz;
          newDst[1] = cx * sy * cz - sx * cy * sz;
          newDst[2] = cx * cy * sz + sx * sy * cz;
          newDst[3] = cx * cy * cz - sx * sy * sz;
          break;
        case "xzy":
          newDst[0] = sx * cy * cz - cx * sy * sz;
          newDst[1] = cx * sy * cz - sx * cy * sz;
          newDst[2] = cx * cy * sz + sx * sy * cz;
          newDst[3] = cx * cy * cz + sx * sy * sz;
          break;
        case "yxz":
          newDst[0] = sx * cy * cz + cx * sy * sz;
          newDst[1] = cx * sy * cz - sx * cy * sz;
          newDst[2] = cx * cy * sz - sx * sy * cz;
          newDst[3] = cx * cy * cz + sx * sy * sz;
          break;
        case "yzx":
          newDst[0] = sx * cy * cz + cx * sy * sz;
          newDst[1] = cx * sy * cz + sx * cy * sz;
          newDst[2] = cx * cy * sz - sx * sy * cz;
          newDst[3] = cx * cy * cz - sx * sy * sz;
          break;
        case "zxy":
          newDst[0] = sx * cy * cz - cx * sy * sz;
          newDst[1] = cx * sy * cz + sx * cy * sz;
          newDst[2] = cx * cy * sz + sx * sy * cz;
          newDst[3] = cx * cy * cz - sx * sy * sz;
          break;
        case "zyx":
          newDst[0] = sx * cy * cz - cx * sy * sz;
          newDst[1] = cx * sy * cz + sx * cy * sz;
          newDst[2] = cx * cy * sz - sx * sy * cz;
          newDst[3] = cx * cy * cz + sx * sy * sz;
          break;
        default:
          throw new Error(`Unknown rotation order: ${order}`);
      }
      return newDst;
    }
    function copy(q, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = q[0];
      newDst[1] = q[1];
      newDst[2] = q[2];
      newDst[3] = q[3];
      return newDst;
    }
    const clone = copy;
    function add(a, b, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = a[0] + b[0];
      newDst[1] = a[1] + b[1];
      newDst[2] = a[2] + b[2];
      newDst[3] = a[3] + b[3];
      return newDst;
    }
    function subtract(a, b, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = a[0] - b[0];
      newDst[1] = a[1] - b[1];
      newDst[2] = a[2] - b[2];
      newDst[3] = a[3] - b[3];
      return newDst;
    }
    const sub = subtract;
    function mulScalar(v, k, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = v[0] * k;
      newDst[1] = v[1] * k;
      newDst[2] = v[2] * k;
      newDst[3] = v[3] * k;
      return newDst;
    }
    const scale = mulScalar;
    function divScalar(v, k, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = v[0] / k;
      newDst[1] = v[1] / k;
      newDst[2] = v[2] / k;
      newDst[3] = v[3] / k;
      return newDst;
    }
    function dot(a, b) {
      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    }
    function lerp(a, b, t, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = a[0] + t * (b[0] - a[0]);
      newDst[1] = a[1] + t * (b[1] - a[1]);
      newDst[2] = a[2] + t * (b[2] - a[2]);
      newDst[3] = a[3] + t * (b[3] - a[3]);
      return newDst;
    }
    function length(v) {
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      const v3 = v[3];
      return Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);
    }
    const len = length;
    function lengthSq(v) {
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      const v3 = v[3];
      return v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3;
    }
    const lenSq = lengthSq;
    function normalize(v, dst) {
      const newDst = dst ?? new Ctor(4);
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      const v3 = v[3];
      const len2 = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);
      if (len2 > 1e-5) {
        newDst[0] = v0 / len2;
        newDst[1] = v1 / len2;
        newDst[2] = v2 / len2;
        newDst[3] = v3 / len2;
      } else {
        newDst[0] = 0;
        newDst[1] = 0;
        newDst[2] = 0;
        newDst[3] = 0;
      }
      return newDst;
    }
    function equalsApproximately(a, b) {
      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[3] - b[3]) < EPSILON;
    }
    function equals(a, b) {
      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
    }
    function identity(dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = 0;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 1;
      return newDst;
    }
    const tempVec3 = vec32.create();
    const xUnitVec3 = vec32.create();
    const yUnitVec3 = vec32.create();
    function rotationTo(aUnit, bUnit, dst) {
      const newDst = dst ?? new Ctor(4);
      const dot2 = vec32.dot(aUnit, bUnit);
      if (dot2 < -0.999999) {
        vec32.cross(xUnitVec3, aUnit, tempVec3);
        if (vec32.len(tempVec3) < 1e-6) {
          vec32.cross(yUnitVec3, aUnit, tempVec3);
        }
        vec32.normalize(tempVec3, tempVec3);
        fromAxisAngle(tempVec3, Math.PI, newDst);
        return newDst;
      } else if (dot2 > 0.999999) {
        newDst[0] = 0;
        newDst[1] = 0;
        newDst[2] = 0;
        newDst[3] = 1;
        return newDst;
      } else {
        vec32.cross(aUnit, bUnit, tempVec3);
        newDst[0] = tempVec3[0];
        newDst[1] = tempVec3[1];
        newDst[2] = tempVec3[2];
        newDst[3] = 1 + dot2;
        return normalize(newDst, newDst);
      }
    }
    const tempQuat1 = new Ctor(4);
    const tempQuat2 = new Ctor(4);
    function sqlerp(a, b, c, d, t, dst) {
      const newDst = dst ?? new Ctor(4);
      slerp(a, d, t, tempQuat1);
      slerp(b, c, t, tempQuat2);
      slerp(tempQuat1, tempQuat2, 2 * t * (1 - t), newDst);
      return newDst;
    }
    return {
      create,
      fromValues,
      set,
      fromAxisAngle,
      toAxisAngle,
      angle,
      multiply,
      mul,
      rotateX,
      rotateY,
      rotateZ,
      slerp,
      inverse,
      conjugate,
      fromMat,
      fromEuler,
      copy,
      clone,
      add,
      subtract,
      sub,
      mulScalar,
      scale,
      divScalar,
      dot,
      lerp,
      length,
      len,
      lengthSq,
      lenSq,
      normalize,
      equalsApproximately,
      equals,
      identity,
      rotationTo,
      sqlerp
    };
  }
  var cache$1 = /* @__PURE__ */ new Map();
  function getAPI$1(Ctor) {
    let api = cache$1.get(Ctor);
    if (!api) {
      api = getAPIImpl$1(Ctor);
      cache$1.set(Ctor, api);
    }
    return api;
  }
  function getAPIImpl(Ctor) {
    function create(x, y, z, w) {
      const newDst = new Ctor(4);
      if (x !== void 0) {
        newDst[0] = x;
        if (y !== void 0) {
          newDst[1] = y;
          if (z !== void 0) {
            newDst[2] = z;
            if (w !== void 0) {
              newDst[3] = w;
            }
          }
        }
      }
      return newDst;
    }
    const fromValues = create;
    function set(x, y, z, w, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = x;
      newDst[1] = y;
      newDst[2] = z;
      newDst[3] = w;
      return newDst;
    }
    function ceil(v, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = Math.ceil(v[0]);
      newDst[1] = Math.ceil(v[1]);
      newDst[2] = Math.ceil(v[2]);
      newDst[3] = Math.ceil(v[3]);
      return newDst;
    }
    function floor(v, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = Math.floor(v[0]);
      newDst[1] = Math.floor(v[1]);
      newDst[2] = Math.floor(v[2]);
      newDst[3] = Math.floor(v[3]);
      return newDst;
    }
    function round(v, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = Math.round(v[0]);
      newDst[1] = Math.round(v[1]);
      newDst[2] = Math.round(v[2]);
      newDst[3] = Math.round(v[3]);
      return newDst;
    }
    function clamp(v, min2 = 0, max2 = 1, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = Math.min(max2, Math.max(min2, v[0]));
      newDst[1] = Math.min(max2, Math.max(min2, v[1]));
      newDst[2] = Math.min(max2, Math.max(min2, v[2]));
      newDst[3] = Math.min(max2, Math.max(min2, v[3]));
      return newDst;
    }
    function add(a, b, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = a[0] + b[0];
      newDst[1] = a[1] + b[1];
      newDst[2] = a[2] + b[2];
      newDst[3] = a[3] + b[3];
      return newDst;
    }
    function addScaled(a, b, scale2, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = a[0] + b[0] * scale2;
      newDst[1] = a[1] + b[1] * scale2;
      newDst[2] = a[2] + b[2] * scale2;
      newDst[3] = a[3] + b[3] * scale2;
      return newDst;
    }
    function subtract(a, b, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = a[0] - b[0];
      newDst[1] = a[1] - b[1];
      newDst[2] = a[2] - b[2];
      newDst[3] = a[3] - b[3];
      return newDst;
    }
    const sub = subtract;
    function equalsApproximately(a, b) {
      return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON && Math.abs(a[2] - b[2]) < EPSILON && Math.abs(a[3] - b[3]) < EPSILON;
    }
    function equals(a, b) {
      return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
    }
    function lerp(a, b, t, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = a[0] + t * (b[0] - a[0]);
      newDst[1] = a[1] + t * (b[1] - a[1]);
      newDst[2] = a[2] + t * (b[2] - a[2]);
      newDst[3] = a[3] + t * (b[3] - a[3]);
      return newDst;
    }
    function lerpV(a, b, t, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = a[0] + t[0] * (b[0] - a[0]);
      newDst[1] = a[1] + t[1] * (b[1] - a[1]);
      newDst[2] = a[2] + t[2] * (b[2] - a[2]);
      newDst[3] = a[3] + t[3] * (b[3] - a[3]);
      return newDst;
    }
    function max(a, b, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = Math.max(a[0], b[0]);
      newDst[1] = Math.max(a[1], b[1]);
      newDst[2] = Math.max(a[2], b[2]);
      newDst[3] = Math.max(a[3], b[3]);
      return newDst;
    }
    function min(a, b, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = Math.min(a[0], b[0]);
      newDst[1] = Math.min(a[1], b[1]);
      newDst[2] = Math.min(a[2], b[2]);
      newDst[3] = Math.min(a[3], b[3]);
      return newDst;
    }
    function mulScalar(v, k, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = v[0] * k;
      newDst[1] = v[1] * k;
      newDst[2] = v[2] * k;
      newDst[3] = v[3] * k;
      return newDst;
    }
    const scale = mulScalar;
    function divScalar(v, k, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = v[0] / k;
      newDst[1] = v[1] / k;
      newDst[2] = v[2] / k;
      newDst[3] = v[3] / k;
      return newDst;
    }
    function inverse(v, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = 1 / v[0];
      newDst[1] = 1 / v[1];
      newDst[2] = 1 / v[2];
      newDst[3] = 1 / v[3];
      return newDst;
    }
    const invert = inverse;
    function dot(a, b) {
      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    }
    function length(v) {
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      const v3 = v[3];
      return Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);
    }
    const len = length;
    function lengthSq(v) {
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      const v3 = v[3];
      return v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3;
    }
    const lenSq = lengthSq;
    function distance(a, b) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      const dw = a[3] - b[3];
      return Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw);
    }
    const dist = distance;
    function distanceSq(a, b) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      const dw = a[3] - b[3];
      return dx * dx + dy * dy + dz * dz + dw * dw;
    }
    const distSq = distanceSq;
    function normalize(v, dst) {
      const newDst = dst ?? new Ctor(4);
      const v0 = v[0];
      const v1 = v[1];
      const v2 = v[2];
      const v3 = v[3];
      const len2 = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3);
      if (len2 > 1e-5) {
        newDst[0] = v0 / len2;
        newDst[1] = v1 / len2;
        newDst[2] = v2 / len2;
        newDst[3] = v3 / len2;
      } else {
        newDst[0] = 0;
        newDst[1] = 0;
        newDst[2] = 0;
        newDst[3] = 0;
      }
      return newDst;
    }
    function negate(v, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = -v[0];
      newDst[1] = -v[1];
      newDst[2] = -v[2];
      newDst[3] = -v[3];
      return newDst;
    }
    function copy(v, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = v[0];
      newDst[1] = v[1];
      newDst[2] = v[2];
      newDst[3] = v[3];
      return newDst;
    }
    const clone = copy;
    function multiply(a, b, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = a[0] * b[0];
      newDst[1] = a[1] * b[1];
      newDst[2] = a[2] * b[2];
      newDst[3] = a[3] * b[3];
      return newDst;
    }
    const mul = multiply;
    function divide(a, b, dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = a[0] / b[0];
      newDst[1] = a[1] / b[1];
      newDst[2] = a[2] / b[2];
      newDst[3] = a[3] / b[3];
      return newDst;
    }
    const div = divide;
    function zero(dst) {
      const newDst = dst ?? new Ctor(4);
      newDst[0] = 0;
      newDst[1] = 0;
      newDst[2] = 0;
      newDst[3] = 0;
      return newDst;
    }
    function transformMat4(v, m, dst) {
      const newDst = dst ?? new Ctor(4);
      const x = v[0];
      const y = v[1];
      const z = v[2];
      const w = v[3];
      newDst[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
      newDst[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
      newDst[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
      newDst[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
      return newDst;
    }
    function setLength(a, len2, dst) {
      const newDst = dst ?? new Ctor(4);
      normalize(a, newDst);
      return mulScalar(newDst, len2, newDst);
    }
    function truncate(a, maxLen, dst) {
      const newDst = dst ?? new Ctor(4);
      if (length(a) > maxLen) {
        return setLength(a, maxLen, newDst);
      }
      return copy(a, newDst);
    }
    function midpoint(a, b, dst) {
      const newDst = dst ?? new Ctor(4);
      return lerp(a, b, 0.5, newDst);
    }
    return {
      create,
      fromValues,
      set,
      ceil,
      floor,
      round,
      clamp,
      add,
      addScaled,
      subtract,
      sub,
      equalsApproximately,
      equals,
      lerp,
      lerpV,
      max,
      min,
      mulScalar,
      scale,
      divScalar,
      inverse,
      invert,
      dot,
      length,
      len,
      lengthSq,
      lenSq,
      distance,
      dist,
      distanceSq,
      distSq,
      normalize,
      negate,
      copy,
      clone,
      multiply,
      mul,
      divide,
      div,
      zero,
      transformMat4,
      setLength,
      truncate,
      midpoint
    };
  }
  var cache = /* @__PURE__ */ new Map();
  function getAPI(Ctor) {
    let api = cache.get(Ctor);
    if (!api) {
      api = getAPIImpl(Ctor);
      cache.set(Ctor, api);
    }
    return api;
  }
  function wgpuMatrixAPI(Mat3Ctor, Mat4Ctor, QuatCtor, Vec2Ctor, Vec3Ctor, Vec4Ctor) {
    return {
      /** @namespace mat4 */
      mat4: getAPI$2(Mat3Ctor),
      /** @namespace mat3 */
      mat3: getAPI$4(Mat4Ctor),
      /** @namespace quat */
      quat: getAPI$1(QuatCtor),
      /** @namespace vec2 */
      vec2: getAPI$5(Vec2Ctor),
      /** @namespace vec3 */
      vec3: getAPI$3(Vec3Ctor),
      /** @namespace vec4 */
      vec4: getAPI(Vec4Ctor)
    };
  }
  var {
    /** @namespace */
    mat4,
    /** @namespace */
    mat3,
    /** @namespace */
    quat,
    /** @namespace */
    vec2,
    /** @namespace */
    vec3,
    /** @namespace */
    vec4
  } = wgpuMatrixAPI(Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array);
  var {
    /** @namespace */
    mat4: mat4d,
    /** @namespace */
    mat3: mat3d,
    /** @namespace */
    quat: quatd,
    /** @namespace */
    vec2: vec2d,
    /** @namespace */
    vec3: vec3d,
    /** @namespace */
    vec4: vec4d
  } = wgpuMatrixAPI(Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array);
  var {
    /** @namespace */
    mat4: mat4n,
    /** @namespace */
    mat3: mat3n,
    /** @namespace */
    quat: quatn,
    /** @namespace */
    vec2: vec2n,
    /** @namespace */
    vec3: vec3n,
    /** @namespace */
    vec4: vec4n
  } = wgpuMatrixAPI(ZeroArray, Array, Array, Array, Array, Array);

  // main.ts
  var vcapBlob;
  var recvBlob;
  var netBlob;
  var vcapWorker;
  var recvWorker;
  var netWorker;
  function ElQuery(str) {
    return document.querySelector(str);
  }
  function StreamStart(mediaStream, offscreenCanvas) {
    const track = mediaStream.getVideoTracks()[0];
    const processor = new MediaStreamTrackProcessor({ track });
    const readable = processor.readable;
    const vcapChannel = new MessageChannel();
    const recvChannel = new MessageChannel();
    vcapWorker.postMessage({ readable, port: vcapChannel.port1 }, [readable, vcapChannel.port1]);
    recvWorker.postMessage({ canvas: offscreenCanvas, port: recvChannel.port1 }, [offscreenCanvas, recvChannel.port1]);
    netWorker.postMessage({ vcapPort: vcapChannel.port2, recvPort: recvChannel.port2 }, [vcapChannel.port2, recvChannel.port2]);
  }
  async function Main() {
    vcapBlob = new Blob([worker_vcap_default], { type: "text/javascript" });
    recvBlob = new Blob([worker_recv_default], { type: "text/javascript" });
    netBlob = new Blob([worker_net_default], { type: "text/javascript" });
    vcapWorker = new Worker(window.URL.createObjectURL(vcapBlob), { name: "worker_vcap", type: "module" });
    recvWorker = new Worker(window.URL.createObjectURL(recvBlob), { name: "worker_recv", type: "module" });
    netWorker = new Worker(window.URL.createObjectURL(netBlob), { name: "worker_net", type: "module" });
    const recvCanvas = ElQuery("#recv_canvas");
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
          audio: true
        }
      );
      StreamStart(mediaStream, offscreenCanvas);
    });
  }
  Main();
})();
