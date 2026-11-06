// Signal chain:
// mic(iRig) -> inputGain -> [analyserRaw]
//                        -> HP x4 -> LP x4 -> [analyserFilt] -> volume -> limiter -> clipper -> fone
export class AudioEngine {
  constructor() {
    this.ctx = null
    this.stream = null
    this.recorder = null
  }

  async start(deviceId) {
    const rawConstraints = {
      // Leak noise is stationary broadband noise: the OS "voice" processing would erase it.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...rawConstraints,
          ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
        },
      })
    } catch (err) {
      console.warn('Falha ao abrir microfone com restrições exatas, tentando modo compatibilidade:', err)
      // Fallback 1: tenta sem o deviceId caso ele tenha sido desconectado ou tenha mudado de ID
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: rawConstraints,
        })
      } catch (err2) {
        // Fallback 2: áudio padrão do sistema caso o navegador recuse as opções avançadas
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        })
      }
    }

    const track = this.stream.getAudioTracks()[0]
    this.trackSettings = track.getSettings()
    this.trackLabel = track.label

    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()

    const src = ctx.createMediaStreamSource(this.stream)
    this.inputGain = ctx.createGain()

    this.analyserRaw = ctx.createAnalyser()
    this.analyserRaw.fftSize = 8192
    this.analyserRaw.smoothingTimeConstant = 0.5
    this.analyserRaw.minDecibels = -130
    this.analyserRaw.maxDecibels = -10

    // 8th-order Butterworth (48 dB/octave) = 4 cascaded biquads with these Qs.
    const BUTTER8_Q = [0.5098, 0.6013, 0.9, 2.5629]
    const mk = (type, q) => {
      const f = ctx.createBiquadFilter()
      f.type = type
      f.Q.value = 20 * Math.log10(q) // Web Audio uses dB for highpass/lowpass Q
      return f
    }
    this.hp = BUTTER8_Q.map((q) => mk('highpass', q))
    this.lp = BUTTER8_Q.map((q) => mk('lowpass', q))

    this.analyserFilt = ctx.createAnalyser()
    this.analyserFilt.fftSize = 2048

    this.volume = ctx.createGain()
    this.volume.gain.value = 0.3

    // Protects the ears from the huge transient when the probe tip is knocked.
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -12
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.001
    this.limiter.release.value = 0.15

    this.clipper = ctx.createWaveShaper()
    const n = 2048
    const curve = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.max(-0.5, Math.min(0.5, x)) // hard ceiling ~ -6 dBFS
    }
    this.clipper.curve = curve

    this.monitor = ctx.createGain()

    src.connect(this.inputGain)
    this.inputGain.connect(this.analyserRaw)
    const chain = [...this.hp, ...this.lp]
    this.inputGain.connect(chain[0])
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1])
    chain[chain.length - 1].connect(this.analyserFilt)
    this.analyserFilt.connect(this.volume)
    this.volume.connect(this.limiter)
    this.limiter.connect(this.clipper)
    this.clipper.connect(this.monitor)
    this.monitor.connect(ctx.destination)

    this.rawTime = new Float32Array(this.analyserRaw.fftSize)
    this.filtTime = new Float32Array(this.analyserFilt.fftSize)
    this.rawSpec = new Float32Array(this.analyserRaw.frequencyBinCount)
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000
  }

  setBand(lo, hi, bypass) {
    if (!this.ctx) return
    const t = this.ctx.currentTime
    const nyq = this.sampleRate / 2
    const loF = bypass ? 10 : lo
    const hiF = bypass ? nyq * 0.99 : hi
    this.hp.forEach((f) => f.frequency.setTargetAtTime(loF, t, 0.02))
    this.lp.forEach((f) => f.frequency.setTargetAtTime(hiF, t, 0.02))
  }

  setInputGainDb(db) {
    if (this.inputGain) this.inputGain.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.02)
  }

  setVolume(v) {
    if (this.volume) this.volume.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02)
  }

  setMonitor(on) {
    if (this.monitor) this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01)
  }

  // Returns { rawPeak, filtDb } and fills this.rawSpec (dBFS per bin).
  read() {
    this.analyserRaw.getFloatTimeDomainData(this.rawTime)
    this.analyserFilt.getFloatTimeDomainData(this.filtTime)
    this.analyserRaw.getFloatFrequencyData(this.rawSpec)
    let peak = 0
    for (let i = 0; i < this.rawTime.length; i++) {
      const a = Math.abs(this.rawTime[i])
      if (a > peak) peak = a
    }
    let sum = 0
    for (let i = 0; i < this.filtTime.length; i++) sum += this.filtTime[i] * this.filtTime[i]
    const rms = Math.sqrt(sum / this.filtTime.length)
    return { rawPeak: peak, filtDb: Math.max(-150, 20 * Math.log10(rms + 1e-12)) }
  }

  startRecording() {
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
    const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t))
    this.chunks = []
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data)
    this.recorder.start()
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.recorder) return resolve(null)
      this.recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: this.recorder.mimeType }))
        this.recorder = null
      }
      this.recorder.stop()
    })
  }

  async stop() {
    if (this.recorder) await this.stopRecording()
    this.stream?.getTracks().forEach((t) => t.stop())
    await this.ctx?.close()
    this.ctx = null
    this.stream = null
  }
}
