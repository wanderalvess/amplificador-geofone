// Plays reference signals on a second device to validate the filters without a real leak.
export const GEN_TYPES = {
  white: 'Ruído branco',
  pink: 'Ruído rosa',
  leak: 'Vazamento simulado',
  tone: 'Tom puro',
}

function noiseBuffer(ctx, pink) {
  const len = ctx.sampleRate * 8
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    if (!pink) {
      d[i] = w * 0.5
      continue
    }
    // Paul Kellet's pink noise filter
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
    b6 = w * 0.115926
  }
  return buf
}

export class TestGenerator {
  async start(type, freq, volume) {
    await this.stop()
    const ctx = new AudioContext()
    this.ctx = ctx
    if (ctx.state === 'suspended') await ctx.resume()
    this.gain = ctx.createGain()
    this.gain.gain.value = volume
    this.gain.connect(ctx.destination)

    if (type === 'tone') {
      this.osc = ctx.createOscillator()
      this.osc.frequency.value = freq
      const g = ctx.createGain()
      g.gain.value = 0.5
      this.osc.connect(g).connect(this.gain)
      this.osc.start()
      return
    }

    const src = ctx.createBufferSource()
    src.buffer = noiseBuffer(ctx, type !== 'white')
    src.loop = true
    this.src = src
    if (type === 'leak') {
      // Leak-like hiss: band-limited noise with slow, small level fluctuation.
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 400
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 1500
      const mod = ctx.createGain()
      mod.gain.value = 1.6
      const lfo = ctx.createOscillator()
      lfo.frequency.value = 0.3
      const lfoDepth = ctx.createGain()
      lfoDepth.gain.value = 0.25
      lfo.connect(lfoDepth).connect(mod.gain)
      lfo.start()
      this.lfo = lfo
      src.connect(hp).connect(lp).connect(mod).connect(this.gain)
    } else {
      src.connect(this.gain)
    }
    src.start()
  }

  setVolume(v) {
    if (this.gain) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02)
  }

  setFreq(f) {
    if (this.osc) this.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02)
  }

  async stop() {
    if (!this.ctx) return
    await this.ctx.close()
    this.ctx = this.osc = this.src = this.lfo = this.gain = null
  }
}
