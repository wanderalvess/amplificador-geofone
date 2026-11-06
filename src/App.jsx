import { useEffect, useRef, useState } from 'react'
import { AudioEngine } from './audioEngine'
import { GEN_TYPES, TestGenerator } from './testGenerator'
import './App.css'

const PRESETS = {
  metal: { label: 'Cano metálico', lo: 500, hi: 2000 },
  pvc: { label: 'PVC / plástico', lo: 100, hi: 800 },
  solo: { label: 'Escuta no solo', lo: 100, hi: 1500 },
  custom: { label: 'Personalizado', lo: 200, hi: 1200 },
}
const MIN_WINDOW_S = 3
const STORAGE_KEY = 'geofone-mvp-points'

function percentile(values, p) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

function colorFor(db) {
  const v = Math.max(0, Math.min(1, (db + 120) / 90))
  const hue = 240 - v * 240
  return `hsl(${hue},100%,${15 + v * 45}%)`
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 },
    )
  })
}

function download(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export default function App() {
  const engine = useRef(null)
  const specCanvas = useRef(null)
  const fallCanvas = useRef(null)
  const levels = useRef([])
  const live = useRef({ minDb: null, curDb: null, peakHz: null })

  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [devices, setDevices] = useState([])
  const [deviceId, setDeviceId] = useState('')
  const [info, setInfo] = useState(null)
  const [preset, setPreset] = useState('pvc')
  const [lo, setLo] = useState(PRESETS.pvc.lo)
  const [hi, setHi] = useState(PRESETS.pvc.hi)
  const [bypass, setBypass] = useState(false)
  const [gainDb, setGainDb] = useState(0)
  const [volume, setVolume] = useState(0.3)
  const [monitor, setMonitor] = useState(true)
  const [maxF, setMaxF] = useState(3000)
  const [readout, setReadout] = useState({ curDb: null, minDb: null, peakHz: null, clip: false })
  const [recording, setRecording] = useState(false)
  const [points, setPoints] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []
    } catch {
      return []
    }
  })
  const [saving, setSaving] = useState(false)
  const [abHold, setAbHold] = useState(false)
  const generator = useRef(null)
  const [genType, setGenType] = useState('leak')
  const [genOn, setGenOn] = useState(false)
  const [genVol, setGenVol] = useState(0.3)
  const [genFreq, setGenFreq] = useState(1000)

  const noFilter = bypass || abHold
  const band = useRef({ lo, hi, bypass: noFilter, maxF })
  band.current = { lo, hi, bypass: noFilter, maxF }

  useEffect(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(points)), [points])
  useEffect(() => engine.current?.setBand(lo, hi, noFilter), [lo, hi, noFilter, running])
  useEffect(() => generator.current?.setVolume(genVol), [genVol])
  useEffect(() => generator.current?.setFreq(genFreq), [genFreq])
  useEffect(() => () => generator.current?.stop(), [])

  async function toggleGenerator(type = genType) {
    if (!generator.current) generator.current = new TestGenerator()
    if (genOn && type === genType) {
      await generator.current.stop()
      setGenOn(false)
    } else {
      await generator.current.start(type, genFreq, genVol)
      setGenType(type)
      setGenOn(true)
    }
  }
  useEffect(() => engine.current?.setInputGainDb(gainDb), [gainDb, running])
  useEffect(() => engine.current?.setVolume(volume), [volume, running])
  useEffect(() => engine.current?.setMonitor(monitor), [monitor, running])

  async function refreshDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices(list.filter((d) => d.kind === 'audioinput'))
    } catch {
      // ignore
    }
  }

  async function start() {
    setError('')
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('Abra a página por HTTPS (ou localhost). O microfone não pode ser acessado em conexões não seguras.')
      return
    }
    try {
      const e = new AudioEngine()
      await e.start(deviceId)
      engine.current = e
      levels.current = []
      setInfo({ label: e.trackLabel, settings: e.trackSettings, sampleRate: e.sampleRate, baseLatency: e.ctx.baseLatency, outputLatency: e.ctx.outputLatency })
      setRunning(true)
      refreshDevices()
      try {
        engine.current.wakeLock = await navigator.wakeLock?.request('screen')
      } catch {
        /* wake lock is optional */
      }
    } catch (err) {
      let msg = 'Erro ao inicializar o áudio.'
      if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        msg = 'Dispositivo de microfone não encontrado. Conecte o fone/microfone ou selecione o "Padrão do Sistema".'
      } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = 'Permissão de acesso ao microfone negada. Autorize o microfone nas configurações do seu navegador.'
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        msg = 'O microfone já está em uso por outro aplicativo ou o sistema operacional bloqueou o acesso.'
      } else if (err.name === 'OverconstrainedError') {
        msg = 'As configurações exigidas para o microfone não são suportadas por este aparelho.'
      } else if (err.name === 'SecurityError') {
        msg = 'Acesso bloqueado por segurança. Acesse através de uma conexão segura HTTPS.'
      } else {
        msg = `${err.name}: ${err.message || 'Erro inesperado ao acessar o microfone'}`
      }
      setError(msg)
    }
  }

  async function stop() {
    setRunning(false)
    if (recording) setRecording(false)
    await engine.current?.wakeLock?.release?.()
    await engine.current?.stop()
    engine.current = null
  }

  async function toggleRecording() {
    const e = engine.current
    if (!e) return
    if (!recording) {
      e.startRecording()
      setRecording(true)
    } else {
      const blob = await e.stopRecording()
      setRecording(false)
      if (blob) {
        const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'
        download(blob, `geofone-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`)
      }
    }
  }

  async function savePoint() {
    setSaving(true)
    const snap = { ...live.current }
    const pos = await getPosition()
    setPoints((p) => [
      ...p,
      {
        id: Date.now(),
        name: `P${p.length + 1}`,
        time: new Date().toISOString(),
        minDb: snap.minDb,
        curDb: snap.curDb,
        peakHz: snap.peakHz,
        lo: band.current.bypass ? null : band.current.lo,
        hi: band.current.bypass ? null : band.current.hi,
        gainDb,
        ...(pos || {}),
      },
    ])
    setSaving(false)
  }

  function exportCsv() {
    const cols = ['name', 'time', 'minDb', 'curDb', 'peakHz', 'lo', 'hi', 'gainDb', 'lat', 'lon', 'acc']
    const rows = points.map((p) => cols.map((c) => (p[c] ?? '')).join(','))
    download(new Blob([[cols.join(','), ...rows].join('\n')], { type: 'text/csv' }), 'geofone-pontos.csv')
  }

  function choosePreset(key) {
    setPreset(key)
    if (key !== 'custom') {
      setLo(PRESETS[key].lo)
      setHi(PRESETS[key].hi)
    }
  }

  // Render loop: spectrum, waterfall, level metrics.
  useEffect(() => {
    if (!running) return
    let raf
    let lastUi = 0
    const loop = (now) => {
      const e = engine.current
      if (!e || !e.ctx) return
      const { rawPeak, filtDb } = e.read()
      const t = now / 1000
      levels.current.push({ t, db: filtDb })
      while (levels.current.length && levels.current[0].t < t - MIN_WINDOW_S) levels.current.shift()
      // 10th percentile ≈ "minimum level"
      const minDb = percentile(levels.current.map((l) => l.db), 0.1)

      const { lo: bLo, hi: bHi, bypass: bBy, maxF: mF } = band.current
      const binHz = e.sampleRate / e.analyserRaw.fftSize
      const spec = e.rawSpec
      const fLo = bBy ? 20 : bLo
      const fHi = bBy ? mF : bHi
      let peakBin = Math.round(fLo / binHz)
      for (let i = Math.round(fLo / binHz); i <= Math.min(spec.length - 1, Math.round(fHi / binHz)); i++) {
        if (spec[i] > spec[peakBin]) peakBin = i
      }
      const peakHz = peakBin * binHz
      live.current = { minDb, curDb: filtDb, peakHz }

      drawSpectrum(specCanvas.current, spec, binHz, mF, bBy ? null : [bLo, bHi], peakHz)
      drawWaterfall(fallCanvas.current, spec, binHz, mF)

      if (now - lastUi > 150) {
        lastUi = now
        setReadout({ curDb: filtDb, minDb, peakHz, clip: rawPeak > 0.98 })
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [running])

  const fmt = (v, d = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(d))
  const valid = points.filter((p) => p.minDb != null && isFinite(p.minDb))
  const pMin = Math.min(...valid.map((p) => p.minDb))
  const pMax = Math.max(...valid.map((p) => p.minDb))

  return (
    <div className="app">
      <header>
        <div className="header-brand">
          <img src="/logo-inovar.jpg" alt="Inovar Tecnologia" className="brand-logo" />
          <div>
            <div className="brand-subtitle">INOVAR TECNOLOGIA INTELIGENTE</div>
            <h1>
              Geofone Eletrônico <span className="badge">Acústico</span>
            </h1>
          </div>
        </div>
        <div className="header-status">
          <div className={`pulse-dot ${running ? 'active' : ''}`} title={running ? 'Sistema ativo' : 'Desconectado'} />
          {!running ? (
            <button className="primary" onClick={start}>▶ Iniciar Escuta</button>
          ) : (
            <button className="danger" onClick={stop}>■ Parar</button>
          )}
        </div>
      </header>

      {error && (
        <div className="error">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      )}

      {/* Entrada de Áudio & Configurações de Hardware */}
      <section className="card">
        <div className="card-title">
          <span>Entrada de Áudio</span>
          {running && <span style={{ color: 'var(--accent-emerald)', fontSize: '11px' }}>● CONECTADO</span>}
        </div>
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={running} onFocus={refreshDevices}>
          <option value="">Padrão do Sistema (iRig / Interface no P2/P3 ou USB)</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Microfone (${d.deviceId.slice(0, 8)})`}</option>
          ))}
        </select>

        {info && (
          <div className="info">
            <div>
              <strong style={{ color: 'var(--text-main)' }}>{info.label || 'Dispositivo de Áudio'}</strong> · {info.sampleRate} Hz · Latência: {fmt((info.baseLatency || 0) * 1000, 0)} ms
              {info.outputLatency ? ` + saída ${fmt(info.outputLatency * 1000, 0)} ms` : ''}
            </div>
            <div className="tags-row">
              {['echoCancellation', 'noiseSuppression', 'autoGainControl'].map((k) => (
                <span key={k} className={info.settings[k] ? 'tag bad' : 'tag ok'}>
                  {k}: {String(info.settings[k] ?? 'n/d')}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Métricas Principais */}
      <section className="meters">
        <div className="meter highlight">
          <span>Nível Mínimo ({MIN_WINDOW_S}s)</span>
          <strong>{fmt(readout.minDb)} <small>dBFS</small></strong>
        </div>
        <div className="meter">
          <span>Nível Atual</span>
          <strong>{fmt(readout.curDb)} <small>dBFS</small></strong>
        </div>
        <div className="meter">
          <span>Pico na Faixa</span>
          <strong>{fmt(readout.peakHz, 0)} <small>Hz</small></strong>
        </div>
        <div className={`meter ${readout.clip ? 'clip' : ''}`}>
          <span>Saturação</span>
          <strong>{readout.clip ? 'CLIPANDO' : 'OK'}</strong>
        </div>
      </section>

      {/* Visualização Espectral */}
      <section className="card">
        <div className="card-title">
          <span>Espectrograma & Espectro em Tempo Real</span>
          <div className="row wrap" style={{ gap: '4px' }}>
            <span>Escala:</span>
            {[1500, 3000, 6000].map((f) => (
              <button key={f} className={maxF === f ? 'sel' : ''} style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => setMaxF(f)}>
                {f / 1000} kHz
              </button>
            ))}
          </div>
        </div>

        <div className="canvas-wrapper">
          <canvas ref={specCanvas} className="spec" />
          <canvas ref={fallCanvas} className="fall" />
          <div className="canvas-legend">
            <span>Espectro (dBFS x Hz) + Cascata Temporal</span>
            <span style={{ color: 'var(--accent-amber)' }}>--- Linha Tracejada: Frequência de Pico</span>
          </div>
        </div>
      </section>

      {/* Filtros e Controle de Som */}
      <section className="card">
        <div className="card-title">
          <span>Filtros Band-Pass & Amplificação</span>
        </div>

        <div className="row wrap">
          {Object.entries(PRESETS).map(([k, p]) => (
            <button key={k} className={preset === k && !bypass ? 'sel' : ''} onClick={() => { choosePreset(k); setBypass(false) }}>
              {p.label}
            </button>
          ))}
          <button className={bypass ? 'sel' : ''} onClick={() => setBypass(!bypass)}>
            Sem Filtro (Bypass)
          </button>
        </div>

        <label>
          <div className="range-label-row">
            <span>Corte Grave (High-pass)</span>
            <span className="range-val">{lo} Hz</span>
          </div>
          <input type="range" min="20" max="2000" step="10" value={lo} disabled={bypass}
            onChange={(e) => { setPreset('custom'); setLo(Math.min(+e.target.value, hi - 50)) }} />
        </label>

        <label>
          <div className="range-label-row">
            <span>Corte Agudo (Low-pass)</span>
            <span className="range-val">{hi} Hz</span>
          </div>
          <input type="range" min="100" max="8000" step="10" value={hi} disabled={bypass}
            onChange={(e) => { setPreset('custom'); setHi(Math.max(+e.target.value, lo + 50)) }} />
        </label>

        <label>
          <div className="range-label-row">
            <span>Ganho Pré-Amp (Entrada)</span>
            <span className="range-val">{gainDb > 0 ? '+' : ''}{gainDb} dB</span>
          </div>
          <input type="range" min="-12" max="40" step="1" value={gainDb} onChange={(e) => setGainDb(+e.target.value)} />
        </label>

        <label>
          <div className="range-label-row">
            <span>Volume no Fone</span>
            <span className="range-val">{Math.round(volume * 100)}%</span>
          </div>
          <input type="range" min="0" max="3" step="0.05" value={volume} onChange={(e) => setVolume(+e.target.value)} />
        </label>

        <button
          className={`hold ${abHold ? 'active' : ''}`}
          disabled={bypass}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setAbHold(true) }}
          onPointerUp={() => setAbHold(false)}
          onPointerCancel={() => setAbHold(false)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {abHold ? '🔊 Ouvindo SEM Filtro (A/B Ativo)' : '🎧 Pressione e Segure para Teste A/B (Sem Filtro)'}
        </button>

        <div className="row" style={{ marginTop: '14px' }}>
          <button className={monitor ? 'sel' : ''} onClick={() => setMonitor(!monitor)}>
            {monitor ? '🎧 Retorno Ativo' : '🔇 Mudo'}
          </button>
          <button className={recording ? 'danger' : ''} disabled={!running} onClick={toggleRecording}>
            {recording ? '⏹ Parar Gravação' : '⏺ Gravar Áudio Bruto'}
          </button>
        </div>
      </section>

      {/* Mapeamento de Pontos Acústicos */}
      <section className="card">
        <div className="card-title">
          <span>Mapeamento de Pontos Acústicos</span>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{points.length} ponto(s) registrado(s)</span>
        </div>

        <div className="row wrap">
          <button className="primary" disabled={!running || saving} onClick={savePoint}>
            {saving ? 'Capturando GPS...' : '📍 Salvar Ponto Atual'}
          </button>
          <button disabled={!points.length} onClick={exportCsv}>
            ⬇ Exportar CSV
          </button>
          <button disabled={!points.length} onClick={() => confirm('Deseja limpar todos os pontos salvos?') && setPoints([])}>
            🗑 Limpar Pontos
          </button>
        </div>

        {valid.length > 0 && (
          <div className="bars-container">
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Comparativo de Ruído Contínuo (Maior barra = Mais próximo do vazamento)
            </div>
            <div className="bars">
              {valid.map((p) => {
                const h = pMax === pMin ? 100 : 15 + ((p.minDb - pMin) / (pMax - pMin)) * 85
                return (
                  <div key={p.id} className="bar">
                    <div className={`fill ${p.minDb === pMax ? 'top' : ''}`} style={{ height: `${h}%` }} title={`${p.name}: ${p.minDb.toFixed(1)} dBFS`} />
                    <span>{p.name}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Ponto</th>
                <th>Mín (dBFS)</th>
                <th>Pico (Hz)</th>
                <th>Faixa</th>
                <th>GPS</th>
                <th style={{ width: '40px' }}></th>
              </tr>
            </thead>
            <tbody>
              {points.length === 0 ? (
                <tr>
                  <td colSpan="6" style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '20px' }}>
                    Nenhum ponto registrado ainda. Clique em "Salvar Ponto Atual" para mapear os locais.
                  </td>
                </tr>
              ) : (
                points.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong></td>
                    <td><span style={{ color: p.minDb === pMax ? 'var(--accent-amber)' : 'inherit', fontWeight: p.minDb === pMax ? '700' : 'normal' }}>{fmt(p.minDb)}</span></td>
                    <td>{fmt(p.peakHz, 0)}</td>
                    <td>{p.lo ? `${p.lo}–${p.hi} Hz` : 'Sem filtro'}</td>
                    <td>
                      {p.lat ? (
                        <a href={`https://maps.google.com/?q=${p.lat},${p.lon}`} target="_blank" rel="noreferrer">
                          📍 ±{Math.round(p.acc)}m
                        </a>
                      ) : '—'}
                    </td>
                    <td>
                      <button className="x" onClick={() => setPoints(points.filter((q) => q.id !== p.id))} title="Excluir ponto">
                        ✕
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Gerador de Sinal para Calibração */}
      <details className="card">
        <summary>
          <span>Gerador de Sinal de Teste (Calibração)</span>
        </summary>
        <p className="hint">
          💡 Use em outro aparelho (celular/notebook) para emitir ruído em cano ou alto-falante e calibrar a sensibilidade da haste/geofone sem causar microfonia de retorno.
        </p>
        <div className="row wrap">
          {Object.entries(GEN_TYPES).map(([k, label]) => (
            <button key={k} className={genOn && genType === k ? 'sel' : ''} onClick={() => toggleGenerator(k)}>
              {genOn && genType === k ? '■ ' : '▶ '}{label}
            </button>
          ))}
        </div>
        {genType === 'tone' && (
          <label>
            <div className="range-label-row">
              <span>Frequência do Tom Puro</span>
              <span className="range-val">{genFreq} Hz</span>
            </div>
            <input type="range" min="50" max="4000" step="10" value={genFreq} onChange={(e) => setGenFreq(+e.target.value)} />
          </label>
        )}
        <label>
          <div className="range-label-row">
            <span>Volume do Gerador</span>
            <span className="range-val">{Math.round(genVol * 100)}%</span>
          </div>
          <input type="range" min="0" max="1" step="0.01" value={genVol} onChange={(e) => setGenVol(+e.target.value)} />
        </label>
      </details>

      <footer>
        <strong>Inovar Serviço · Tecnologia Inteligente</strong> — Geofone Acústico Digital. O nível mínimo contínuo é o indicador principal de proximidade do vazamento.
      </footer>
    </div>
  )
}

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(c.clientWidth * dpr)
  const h = Math.round(c.clientHeight * dpr)
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
    return true
  }
  return false
}

function drawSpectrum(c, spec, binHz, maxF, bandRange, peakHz) {
  if (!c) return
  fitCanvas(c)
  const g = c.getContext('2d')
  const { width: w, height: h } = c
  const dbMin = -130
  const dbMax = -20
  g.fillStyle = '#06090e'
  g.fillRect(0, 0, w, h)
  
  if (bandRange) {
    g.fillStyle = 'rgba(56, 189, 248, 0.12)'
    g.fillRect((bandRange[0] / maxF) * w, 0, ((bandRange[1] - bandRange[0]) / maxF) * w, h)
  }
  
  g.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  g.fillStyle = '#64748b'
  g.font = `${10 * (window.devicePixelRatio || 1)}px monospace`
  const step = maxF <= 1500 ? 250 : maxF <= 3000 ? 500 : 1000
  for (let f = step; f < maxF; f += step) {
    const x = (f / maxF) * w
    g.beginPath()
    g.moveTo(x, 0)
    g.lineTo(x, h)
    g.stroke()
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 4, h - 6)
  }
  
  const nBins = Math.min(spec.length, Math.ceil(maxF / binHz))
  g.strokeStyle = '#38bdf8'
  g.lineWidth = 1.8 * (window.devicePixelRatio || 1)
  g.beginPath()
  for (let i = 1; i < nBins; i++) {
    const x = ((i * binHz) / maxF) * w
    const y = h - ((spec[i] - dbMin) / (dbMax - dbMin)) * h
    i === 1 ? g.moveTo(x, y) : g.lineTo(x, y)
  }
  g.stroke()
  
  if (peakHz) {
    const x = (peakHz / maxF) * w
    g.strokeStyle = '#f59e0b'
    g.lineWidth = 1.5 * (window.devicePixelRatio || 1)
    g.setLineDash([4, 4])
    g.beginPath()
    g.moveTo(x, 0)
    g.lineTo(x, h)
    g.stroke()
    g.setLineDash([])
  }
}

function drawWaterfall(c, spec, binHz, maxF) {
  if (!c) return
  if (fitCanvas(c)) c.getContext('2d').fillRect(0, 0, c.width, c.height)
  const g = c.getContext('2d')
  const { width: w, height: h } = c
  g.drawImage(c, 0, 0, w, h - 1, 0, 1, w, h - 1)
  for (let x = 0; x < w; x++) {
    const i = Math.min(spec.length - 1, Math.round(((x / w) * maxF) / binHz))
    g.fillStyle = colorFor(spec[i])
    g.fillRect(x, 0, 1, 1)
  }
}
