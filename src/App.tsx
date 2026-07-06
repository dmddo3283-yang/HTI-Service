import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BasicPitch as BasicPitchModel, NoteEventTime } from '@spotify/basic-pitch'
import type { Sampler } from 'tone'

type AppState = 'idle' | 'recording' | 'recorded' | 'converting' | 'ready' | 'error'

// 편집을 위해 각 음에 안정적인 id를 붙인 형태. (추가/삭제/정렬 후에도 추적 가능)
type EditableNote = NoteEventTime & { id: number }

const MAX_RECORDING_SECONDS = 30
const MODEL_URL = '/basic-pitch-model/model.json'

const PITCH_MIN = 21
const PITCH_MAX = 108
const PITCH_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

// 음정 자동 보정용 음계 (루트로부터의 반음 오프셋)
type ScaleType = 'chromatic' | 'major' | 'minor' | 'majorPent' | 'minorPent'
const SCALES: Record<ScaleType, { label: string; steps: number[] }> = {
  chromatic: { label: '반음계(전체)', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  major: { label: '장음계', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: '단음계', steps: [0, 2, 3, 5, 7, 8, 10] },
  majorPent: { label: '장5음계', steps: [0, 2, 4, 7, 9] },
  minorPent: { label: '단5음계', steps: [0, 3, 5, 7, 10] },
}

// 박자 자동 보정용 그리드 (박 단위 길이)
type GridDivision = '1/4' | '1/8' | '1/16' | '1/8t'
const GRIDS: Record<GridDivision, { label: string; beats: number }> = {
  '1/4': { label: '1/4 (♩)', beats: 1 },
  '1/8': { label: '1/8 (♪)', beats: 0.5 },
  '1/16': { label: '1/16', beats: 0.25 },
  '1/8t': { label: '1/8 셋잇단', beats: 1 / 3 },
}

// 이상치(과도하게 엇나가는 음) 제거 기준 — 주변 멜로디에서 이 반음 이상 벗어나면 삭제
const OUTLIER_THRESHOLDS: { value: number; label: string }[] = [
  { value: 7, label: '±7반음(5도)' },
  { value: 10, label: '±10반음' },
  { value: 12, label: '±12반음(옥타브)' },
  { value: 15, label: '±15반음' },
]

const clampPitch = (pitch: number) => Math.min(PITCH_MAX, Math.max(PITCH_MIN, Math.round(pitch)))
const sortByTime = (list: EditableNote[]) => [...list].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)

// 주변 음들의 중앙값(median)에서 threshold 반음 이상 벗어난 음을 이상치로 본다.
// median은 한두 개의 튄 음에 흔들리지 않으므로, 진짜 큰 도약(여러 음이 함께 이동)은 남기고
// 혼자 튄 검출 오류만 골라낸다. 삭제할 음들의 id 집합을 돌려준다.
function findPitchOutliers(list: EditableNote[], threshold: number) {
  const outliers = new Set<number>()
  if (list.length < 3) return outliers
  const sorted = sortByTime(list)
  for (let index = 0; index < sorted.length; index += 1) {
    const neighbors: number[] = []
    for (let near = Math.max(0, index - 3); near <= Math.min(sorted.length - 1, index + 3); near += 1) {
      if (near !== index) neighbors.push(sorted[near].pitchMidi)
    }
    if (neighbors.length < 2) continue
    neighbors.sort((a, b) => a - b)
    const median = neighbors[Math.floor(neighbors.length / 2)]
    if (Math.abs(sorted[index].pitchMidi - median) >= threshold) outliers.add(sorted[index].id)
  }
  return outliers
}

// 한 음의 음정을 선택한 조성/음계에서 가장 가까운 음으로 스냅한다.
function snapPitchToScale(pitchMidi: number, root: number, steps: number[]) {
  const relative = ((pitchMidi - root) % 12 + 12) % 12
  let bestOffset = 0
  let bestDistance = Infinity
  for (const step of steps) {
    for (const candidate of [step - 12, step, step + 12]) {
      const distance = Math.abs(candidate - relative)
      if (distance < bestDistance) {
        bestDistance = distance
        bestOffset = candidate - relative
      }
    }
  }
  return clampPitch(pitchMidi + bestOffset)
}

const Icon = ({ name, size = 20 }: { name: 'mic' | 'stop' | 'spark' | 'play' | 'pause' | 'download' | 'wave'; size?: number }) => {
  const paths = {
    mic: <><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    spark: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z"/></>,
    play: <path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none"/>,
    pause: <><path d="M8 5v14M16 5v14"/></>,
    download: <><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"/></>,
    wave: <path d="M3 12h2l2-7 3 14 3-11 2 8 2-4h4"/>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

const formatTime = (seconds: number) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, '0')}`
}

function LevelMeter({ analyser, active }: { analyser: AnalyserNode | null; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    let frame = 0
    const values = new Uint8Array(analyser?.frequencyBinCount ?? 64)

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      if (canvas.width !== width * scale || canvas.height !== height * scale) {
        canvas.width = width * scale
        canvas.height = height * scale
      }
      context.setTransform(scale, 0, 0, scale, 0, 0)
      context.clearRect(0, 0, width, height)
      if (analyser && active) analyser.getByteFrequencyData(values)
      const bars = 42
      const gap = 3
      const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars)
      for (let i = 0; i < bars; i += 1) {
        const sourceIndex = Math.floor((i / bars) * values.length * 0.48)
        const live = active ? values[sourceIndex] / 255 : 0.08 + Math.sin(i * 1.8) * 0.025
        const barHeight = Math.max(3, live * height * 0.86)
        context.fillStyle = active ? `rgba(232, 255, 78, ${0.42 + live * 0.58})` : 'rgba(255,255,255,.14)'
        context.beginPath()
        context.roundRect(i * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight, 3)
        context.fill()
      }
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [active, analyser])

  return <canvas className="level-meter" ref={canvasRef} />
}

type PianoRollProps = {
  notes: EditableNote[]
  duration: number
  position: number
  editable?: boolean
  selectedId?: number | null
  onSelect?: (id: number | null) => void
  onEditStart?: () => void
  onMoveNote?: (id: number, startTimeSeconds: number, pitchMidi: number) => void
  onResizeNote?: (id: number, durationSeconds: number) => void
  onAddNote?: (startTimeSeconds: number, pitchMidi: number) => void
  onDeleteNote?: (id: number) => void
}

function PianoRoll({ notes, duration, position, editable = false, selectedId = null, onSelect, onEditStart, onMoveNote, onResizeNote, onAddNote, onDeleteNote }: PianoRollProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ mode: 'move' | 'resize'; id: number; grabDx: number } | null>(null)
  const didEditRef = useRef(false)

  const [frozenRange, setFrozenRange] = useState<{ minPitch: number; maxPitch: number } | null>(null)
  const computedRange = useMemo(() => {
    if (!notes.length) return { minPitch: 48, maxPitch: 72 }
    const pitches = notes.map((note) => note.pitchMidi)
    return {
      minPitch: Math.max(21, Math.min(...pitches) - 4),
      maxPitch: Math.min(108, Math.max(...pitches) + 4),
    }
  }, [notes])
  // 드래그 중에는 음역 범위를 고정해 화면(세로 배율)이 출렁이지 않게 한다.
  const minPitch = frozenRange?.minPitch ?? computedRange.minPitch
  const maxPitch = frozenRange?.maxPitch ?? computedRange.maxPitch
  const rows = maxPitch - minPitch + 1
  const width = Math.max(780, duration * 90)
  const height = Math.max(320, rows * 16)
  const rowHeight = height / rows
  const labelWidth = 58
  const spanWidth = width - labelWidth
  const timeToX = (time: number) => labelWidth + (time / Math.max(duration, 0.01)) * spanWidth
  const playheadX = timeToX(position)
  const blackKeys = new Set([1, 3, 6, 8, 10])
  const pitchName = (pitch: number) => `${PITCH_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`

  // 포인터 위치(클라이언트 좌표)를 피아노롤의 시간/음정으로 변환한다.
  const pointerToCoords = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const x = (event.clientX - rect.left) * (width / rect.width)
    const y = (event.clientY - rect.top) * (height / rect.height)
    const time = Math.max(0, ((x - labelWidth) / spanWidth) * Math.max(duration, 0.01))
    const pitch = maxPitch - Math.floor(y / rowHeight)
    return { x, time, pitch }
  }

  const ensureEditStarted = () => {
    if (!didEditRef.current) {
      didEditRef.current = true
      onEditStart?.()
    }
  }

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!editable) return
    const target = event.target as SVGElement
    const rawId = target.dataset.noteId
    didEditRef.current = false
    if (rawId === undefined) {
      onSelect?.(null)
      return
    }
    const id = Number(rawId)
    const note = notes.find((item) => item.id === id)
    if (!note) return
    const { time } = pointerToCoords(event)
    dragRef.current = {
      mode: target.dataset.handle ? 'resize' : 'move',
      id,
      grabDx: time - note.startTimeSeconds,
    }
    onSelect?.(id)
    setFrozenRange({ minPitch, maxPitch })
    try { svgRef.current?.setPointerCapture(event.pointerId) } catch { /* 포인터 캡처 미지원 시 무시 */ }
  }

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const { time, pitch } = pointerToCoords(event)
    ensureEditStarted()
    if (drag.mode === 'resize') {
      const note = notes.find((item) => item.id === drag.id)
      if (note) onResizeNote?.(drag.id, time - note.startTimeSeconds)
    } else {
      onMoveNote?.(drag.id, time - drag.grabDx, pitch)
    }
  }

  const handlePointerUp = (event: React.PointerEvent) => {
    if (dragRef.current) {
      dragRef.current = null
      setFrozenRange(null)
      try { svgRef.current?.releasePointerCapture(event.pointerId) } catch { /* 무시 */ }
    }
  }

  const handleDoubleClick = (event: React.MouseEvent) => {
    if (!editable) return
    const target = event.target as SVGElement
    const rawId = target.dataset.noteId
    if (rawId !== undefined) {
      onDeleteNote?.(Number(rawId))
      return
    }
    const { x, time, pitch } = pointerToCoords(event)
    if (x <= labelWidth) return
    onAddNote?.(time, pitch)
  }

  return (
    <div className="piano-roll-scroll">
      <svg
        ref={svgRef}
        className={`piano-roll${editable ? ' editable' : ''}`}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="변환된 MIDI 피아노롤"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        <rect width={width} height={height} fill="#121316" />
        {Array.from({ length: rows }, (_, index) => {
          const pitch = maxPitch - index
          const y = index * rowHeight
          const dark = blackKeys.has(pitch % 12)
          return <g key={pitch} style={{ pointerEvents: 'none' }}>
            <rect x={labelWidth} y={y} width={spanWidth} height={rowHeight} fill={dark ? '#17191d' : '#1c1e22'} />
            <line x1={labelWidth} x2={width} y1={y} y2={y} stroke="#2a2c31" strokeWidth="1" />
            <rect x="0" y={y} width={labelWidth} height={rowHeight} fill={dark ? '#17181b' : '#e9e9e5'} stroke="#3b3c40" />
            {pitch % 12 === 0 && <text x="8" y={y + rowHeight - 4} fontSize="9" fill={dark ? '#aaa' : '#27282a'}>{pitchName(pitch)}</text>}
          </g>
        })}
        {Array.from({ length: Math.ceil(duration) + 1 }, (_, second) => {
          const x = timeToX(second)
          return <g key={second} style={{ pointerEvents: 'none' }}>
            <line x1={x} x2={x} y1={0} y2={height} stroke={second % 4 === 0 ? '#46494f' : '#303238'} strokeWidth={second % 4 === 0 ? 1.2 : 1} />
            {second % 2 === 0 && <text x={x + 4} y="13" fontSize="9" fill="#74777e">{second}s</text>}
          </g>
        })}
        {notes.map((note) => {
          const x = timeToX(note.startTimeSeconds)
          const y = (maxPitch - note.pitchMidi) * rowHeight + 2
          const noteWidth = Math.max(8, (note.durationSeconds / Math.max(duration, 0.01)) * spanWidth)
          const noteHeight = Math.max(7, rowHeight - 4)
          const selected = note.id === selectedId
          return <g key={note.id}>
            <rect
              data-note-id={note.id}
              className={`midi-note${selected ? ' selected' : ''}${editable ? ' editable' : ''}`}
              x={x}
              y={y}
              width={noteWidth}
              height={noteHeight}
              rx="3"
            />
            {editable && (
              <rect
                data-note-id={note.id}
                data-handle="1"
                className="midi-note-handle"
                x={x + noteWidth - 6}
                y={y}
                width={6}
                height={noteHeight}
              />
            )}
          </g>
        })}
        <line className="playhead" x1={playheadX} x2={playheadX} y1="0" y2={height} style={{ pointerEvents: 'none' }} />
        <path d={`M${playheadX - 5} 0h10l-5 7Z`} fill="#f5ff69" style={{ pointerEvents: 'none' }} />
      </svg>
    </div>
  )
}

async function preprocessHumming(buffer: AudioBuffer) {
  const length = Math.ceil(buffer.duration * 22050)
  const offline = new OfflineAudioContext(1, length, 22050)
  const source = offline.createBufferSource()
  const highpass = offline.createBiquadFilter()
  const lowpass = offline.createBiquadFilter()
  const compressor = offline.createDynamicsCompressor()

  highpass.type = 'highpass'
  highpass.frequency.value = 70
  highpass.Q.value = 0.7
  lowpass.type = 'lowpass'
  // basic-pitch는 음정 판별에 기본음의 최대 7배음까지 사용한다(주석 음역 최고 ~4186Hz).
  // 3200Hz로 자르면 중·고음 허밍의 상위 배음이 지워져 옥타브 오류·높은음 누락이 생긴다.
  // 배음을 살리도록 컷오프를 높인다.
  lowpass.frequency.value = 4800
  lowpass.Q.value = 0.55
  // 압축을 다소 완만하게: 과한 압축은 배음 간 크기 비율을 왜곡해 모델을 헷갈리게 한다.
  // 그래도 여린 음 꼬리는 어느 정도 들어 올린다.
  compressor.threshold.value = -30
  compressor.knee.value = 20
  compressor.ratio.value = 2.5
  compressor.attack.value = 0.006
  compressor.release.value = 0.12

  source.buffer = buffer
  source.connect(highpass)
  highpass.connect(lowpass)
  lowpass.connect(compressor)
  compressor.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  const samples = rendered.getChannelData(0)
  const frameSize = 441
  const rmsValues: number[] = []

  for (let start = 0; start < samples.length; start += frameSize) {
    let sum = 0
    const end = Math.min(samples.length, start + frameSize)
    for (let index = start; index < end; index += 1) sum += samples[index] ** 2
    rmsValues.push(Math.sqrt(sum / Math.max(1, end - start)))
  }

  const sortedRms = [...rmsValues].sort((a, b) => a - b)
  const noiseFloor = sortedRms[Math.floor(sortedRms.length * 0.2)] ?? 0
  const strongSignal = sortedRms[Math.floor(sortedRms.length * 0.9)] ?? 0
  // 잡음이 검출로 새어 들어가지 않도록 게이트 문턱을 좀 더 높게 잡는다.
  const gateThreshold = Math.min(
    strongSignal * 0.32,
    Math.max(0.0018, noiseFloor * 3, strongSignal * 0.08),
  )
  const attack = 1 - Math.exp(-1 / (0.003 * 22050))
  // release를 늘려 음의 끝자락이 급하게 잘리지 않도록 한다. (음이 조각나는 것을 줄임)
  const release = 1 - Math.exp(-1 / (0.08 * 22050))
  let envelope = 0
  let peak = 0

  for (let index = 0; index < samples.length; index += 1) {
    const frameRms = rmsValues[Math.floor(index / frameSize)] ?? 0
    // 게이트에 걸린 구간을 8%로 낮춰 음 사이 잡음을 더 눌러준다.
    // (너무 낮추면 여린 음의 시작·끝까지 사라지므로 완전히 죽이지는 않는다.)
    const target = frameRms >= gateThreshold ? 1 : 0.08
    envelope += (target - envelope) * (target > envelope ? attack : release)
    samples[index] *= envelope
    peak = Math.max(peak, Math.abs(samples[index]))
  }

  // 작은 목소리는 적당히 키우되, 잔여 노이즈까지 과도하게 증폭하지 않는다.
  const normalization = peak > 0.005 ? Math.min(4, 0.86 / peak) : 1
  if (normalization > 1) {
    for (let index = 0; index < samples.length; index += 1) samples[index] *= normalization
  }

  return rendered
}

function overlapRatio(a: NoteEventTime, b: NoteEventTime) {
  const start = Math.max(a.startTimeSeconds, b.startTimeSeconds)
  const end = Math.min(a.startTimeSeconds + a.durationSeconds, b.startTimeSeconds + b.durationSeconds)
  return Math.max(0, end - start) / Math.max(0.001, Math.min(a.durationSeconds, b.durationSeconds))
}

function cleanHummingNotes(rawNotes: NoteEventTime[]) {
  if (!rawNotes.length) return []
  const amplitudes = rawNotes.map((note) => note.amplitude).sort((a, b) => a - b)
  const medianAmplitude = amplitudes[Math.floor(amplitudes.length / 2)] ?? 0
  // 잡음성 음을 걸러내기 위해 신뢰도 바닥값과 최소 길이를 높인다. (잡음 감소)
  const confidenceFloor = Math.max(0.14, medianAmplitude * 0.38)
  const candidates = rawNotes
    .filter((note) => note.durationSeconds >= 0.1 && note.amplitude >= confidenceFloor)
    .filter((note) => note.pitchMidi >= 33 && note.pitchMidi <= 96)

  // 허밍은 단선율이므로, 강한 기본음과 동시에 생긴 약한 배음(주로 옥타브)을 제거한다.
  const withoutHarmonics = candidates.filter((note, index) => !candidates.some((other, otherIndex) => {
    if (index === otherIndex || other.amplitude <= note.amplitude * 1.08) return false
    const interval = Math.abs(other.pitchMidi - note.pitchMidi)
    const looksLikeHarmonic = [12, 19, 24].some((harmonic) => Math.abs(interval - harmonic) <= 1)
    return looksLikeHarmonic && overlapRatio(note, other) >= 0.62
  }))

  const stabilized = withoutHarmonics
    .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)
    .map((note) => ({ ...note }))

  // 앞뒤 음이 비슷한데 가운데만 한 옥타브 튄 경우를 배음 오류로 보고 교정한다.
  for (let index = 1; index < stabilized.length - 1; index += 1) {
    const previous = stabilized[index - 1]
    const current = stabilized[index]
    const next = stabilized[index + 1]
    if (Math.abs(previous.pitchMidi - next.pitchMidi) > 3 || current.durationSeconds > 0.65) continue
    const neighborPitch = Math.round((previous.pitchMidi + next.pitchMidi) / 2)
    const difference = current.pitchMidi - neighborPitch
    const octaves = Math.round(difference / 12)
    if (octaves !== 0 && Math.abs(difference - octaves * 12) <= 1) current.pitchMidi -= octaves * 12
  }

  const merged: NoteEventTime[] = []
  for (const note of stabilized) {
    const previous = merged[merged.length - 1]
    const previousEnd = previous ? previous.startTimeSeconds + previous.durationSeconds : 0
    const smallPitchWobble = previous && Math.abs(previous.pitchMidi - note.pitchMidi) <= 1
    // 병합 조건을 더 보수적으로: 아주 짧은 조각(<0.2s)이 거의 붙어 있을(≤0.06s) 때만 합쳐
    // 실제로 반복되는 음을 하나로 뭉개지 않도록 한다.
    const oneFragmentIsShort = previous && Math.min(previous.durationSeconds, note.durationSeconds) < 0.2
    if (previous && smallPitchWobble && oneFragmentIsShort && note.startTimeSeconds - previousEnd <= 0.06) {
      const noteEnd = note.startTimeSeconds + note.durationSeconds
      if (note.amplitude > previous.amplitude) previous.pitchMidi = note.pitchMidi
      previous.durationSeconds = Math.max(previousEnd, noteEnd) - previous.startTimeSeconds
      previous.amplitude = Math.max(previous.amplitude, note.amplitude)
      continue
    }
    merged.push(note)
  }

  return merged
}

function App() {
  const [appState, setAppState] = useState<AppState>('idle')
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [recordedBuffer, setRecordedBuffer] = useState<AudioBuffer | null>(null)
  const [notes, setNotes] = useState<EditableNote[]>([])
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('버튼을 누르고 떠오른 멜로디를 불러보세요.')
  const [isPlaying, setIsPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [instrumentReady, setInstrumentReady] = useState(false)

  // 편집/보정 상태
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [history, setHistory] = useState<EditableNote[][]>([])
  const [scaleRoot, setScaleRoot] = useState(0)
  const [scaleType, setScaleType] = useState<ScaleType>('major')
  const [bpm, setBpm] = useState(120)
  const [gridDivision, setGridDivision] = useState<GridDivision>('1/8')
  const [outlierThreshold, setOutlierThreshold] = useState(12)
  const [originalNotes, setOriginalNotes] = useState<EditableNote[]>([])
  const noteIdRef = useRef(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordingStartedRef = useRef(0)
  const recordingTimerRef = useRef<number | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const modelRef = useRef<BasicPitchModel | null>(null)
  const samplerRef = useRef<Sampler | null>(null)
  const toneRef = useRef<typeof import('tone') | null>(null)
  const playbackTimerRef = useRef<number | null>(null)
  const nextNoteIndexRef = useRef(0)
  const animationRef = useRef<number | null>(null)
  const playStartedAtRef = useRef(0)
  const playStartPositionRef = useRef(0)

  const midiDuration = useMemo(() => notes.reduce((max, note) => Math.max(max, note.startTimeSeconds + note.durationSeconds), recordedBuffer?.duration ?? 0), [notes, recordedBuffer])
  const canConvert = appState === 'recorded' && Boolean(recordedBuffer)

  const cleanupRecording = useCallback(() => {
    if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current)
    recordingTimerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    audioContextRef.current?.close().catch(() => undefined)
    audioContextRef.current = null
    setAnalyser(null)
  }, [])

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
  }, [])

  const startRecording = async () => {
    try {
      stopPlayback(true)
      setMessage('마이크를 준비하고 있어요…')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } })
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const meter = context.createAnalyser()
      meter.fftSize = 256
      meter.smoothingTimeConstant = 0.78
      source.connect(meter)
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (event) => event.data.size && chunksRef.current.push(event.data)
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        cleanupRecording()
        try {
          const decodeContext = new AudioContext()
          const decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer())
          await decodeContext.close()
          setRecordedBuffer(decoded)
          setAppState('recorded')
          setMessage(`${formatTime(decoded.duration)}의 멜로디를 담았어요. 이제 MIDI로 바꿔볼까요?`)
        } catch {
          setAppState('error')
          setMessage('녹음 파일을 읽지 못했어요. 다시 녹음해 주세요.')
        }
      }
      mediaRecorderRef.current = recorder
      streamRef.current = stream
      audioContextRef.current = context
      setAnalyser(meter)
      setNotes([])
      setPosition(0)
      setRecordingSeconds(0)
      recordingStartedRef.current = context.currentTime
      recorder.start(250)
      setAppState('recording')
      setMessage('편하게 허밍하세요. 음 사이를 살짝 나누면 더 잘 알아들어요.')
      recordingTimerRef.current = window.setInterval(() => {
        const elapsed = context.currentTime - recordingStartedRef.current
        setRecordingSeconds(elapsed)
        if (elapsed >= MAX_RECORDING_SECONDS) stopRecording()
      }, 100)
    } catch {
      setAppState('error')
      setMessage('마이크를 사용할 수 없어요. 브라우저의 마이크 권한을 확인해 주세요.')
    }
  }

  const convertToMidi = async () => {
    if (!recordedBuffer) return
    setAppState('converting')
    setProgress(0.02)
    setMessage('소리의 음정과 타이밍을 읽고 있어요…')
    try {
      const monoBuffer = await preprocessHumming(recordedBuffer)
      const {
        addPitchBendsToNoteEvents,
        BasicPitch,
        noteFramesToTime,
        outputToNotesPoly,
      } = await import('@spotify/basic-pitch')
      if (!modelRef.current) modelRef.current = new BasicPitch(MODEL_URL)
      const frames: number[][] = []
      const onsets: number[][] = []
      const contours: number[][] = []
      await modelRef.current.evaluateModel(
        monoBuffer,
        (frameBatch, onsetBatch, contourBatch) => {
          frames.push(...frameBatch)
          onsets.push(...onsetBatch)
          contours.push(...contourBatch)
        },
        (value) => setProgress(value),
      )
      // onsetThresh·frameThresh를 올려 잡음이 만든 약한 검출을 배제하고, 최소 음 길이(프레임)도
      // 늘려 짧은 잡음 조각을 걸러낸다. 음역대(minFreq/maxFreq)는 허밍 범위로 유지한다.
      const detected = cleanHummingNotes(noteFramesToTime(
        addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.37, 0.26, 8, true, 1200, 65, true, 11)),
      ))
      // 편집을 위해 각 음에 id를 부여하고, '원본 복원'용으로 검출 결과를 보관한다.
      const withIds: EditableNote[] = detected.map((note) => ({ ...note, id: (noteIdRef.current += 1) }))
      setOriginalNotes(withIds)
      setNotes(withIds)
      setHistory([])
      setSelectedId(null)
      setPosition(0)
      setAppState('ready')
      setMessage(detected.length ? `${detected.length}개의 음표를 찾았어요. 피아노 소리로 들어보세요.` : '분명한 음표를 찾지 못했어요. 조금 더 크게 다시 불러보세요.')
    } catch (error) {
      console.error(error)
      setAppState('error')
      setMessage('MIDI 변환 중 문제가 생겼어요. 녹음을 다시 시도해 주세요.')
    }
  }

  const ensureSampler = async () => {
    const ToneRuntime = toneRef.current ?? await import('tone')
    toneRef.current = ToneRuntime
    await ToneRuntime.start()
    if (samplerRef.current) return { sampler: samplerRef.current, ToneRuntime }
    const { SampleLibrary } = await import('./vendor/tonejs-instruments')
    const sampler = SampleLibrary.load({ instruments: 'piano', baseUrl: '/samples/', ext: '.mp3', minify: true, onload: () => undefined })
    sampler.release = 0.08
    sampler.volume.value = -100
    sampler.toDestination()
    samplerRef.current = sampler
    await ToneRuntime.loaded()
    setInstrumentReady(true)
    return { sampler, ToneRuntime }
  }

  const stopPlayback = useCallback((reset = false) => {
    if (playbackTimerRef.current) window.clearInterval(playbackTimerRef.current)
    playbackTimerRef.current = null
    if (samplerRef.current) samplerRef.current.volume.value = -100
    const now = toneRef.current?.now()
    if (now !== undefined) samplerRef.current?.releaseAll(now)
    else samplerRef.current?.releaseAll()
    if (animationRef.current) cancelAnimationFrame(animationRef.current)
    animationRef.current = null
    setIsPlaying(false)
    if (reset) setPosition(0)
  }, [])

  const startPlayback = async () => {
    if (!notes.length) return
    setMessage('피아노 샘플을 준비하고 있어요…')
    const { sampler, ToneRuntime } = await ensureSampler()
    const startPosition = position >= midiDuration - 0.03 ? 0 : position
    setPosition(startPosition)
    playStartPositionRef.current = startPosition
    playStartedAtRef.current = performance.now()
    sampler.releaseAll(ToneRuntime.now())
    sampler.volume.value = 0
    const nextNoteIndex = notes.findIndex((note) => note.startTimeSeconds + note.durationSeconds > startPosition)
    nextNoteIndexRef.current = nextNoteIndex === -1 ? notes.length : nextNoteIndex

    const scheduleDueNotes = () => {
      const currentPosition = playStartPositionRef.current + Math.max(0, (performance.now() - playStartedAtRef.current) / 1000)
      while (nextNoteIndexRef.current < notes.length) {
        const note = notes[nextNoteIndexRef.current]
        if (note.startTimeSeconds > currentPosition + 0.025) break
        const noteEnd = note.startTimeSeconds + note.durationSeconds
        if (noteEnd > currentPosition) {
          const pitch = ToneRuntime.Frequency(note.pitchMidi, 'midi').toNote()
          const duration = Math.max(0.06, noteEnd - currentPosition)
          sampler.triggerAttackRelease(pitch, duration, ToneRuntime.now(), Math.min(0.95, Math.max(0.3, note.amplitude)))
        }
        nextNoteIndexRef.current += 1
      }
    }
    scheduleDueNotes()
    playbackTimerRef.current = window.setInterval(scheduleDueNotes, 16)
    setIsPlaying(true)
    setMessage(instrumentReady ? '멜로디를 재생하고 있어요.' : '피아노 준비 완료. 멜로디를 재생하고 있어요.')
    const tick = () => {
      const elapsed = Math.max(0, (performance.now() - playStartedAtRef.current) / 1000)
      const next = playStartPositionRef.current + elapsed
      if (next >= midiDuration) {
        setPosition(midiDuration)
        stopPlayback(false)
        return
      }
      setPosition(next)
      animationRef.current = requestAnimationFrame(tick)
    }
    animationRef.current = requestAnimationFrame(tick)
  }

  const togglePlayback = () => isPlaying ? stopPlayback(false) : void startPlayback()

  const seek = (value: number) => {
    if (isPlaying) stopPlayback(false)
    setPosition(value)
  }

  // 편집을 시작할 때 현재 상태를 되돌리기 스택에 쌓는다. (제스처/보정당 한 번)
  const beginEdit = () => {
    if (isPlaying) stopPlayback(false)
    setHistory((stack) => [...stack.slice(-49), notes])
  }

  const moveNote = (id: number, startTimeSeconds: number, pitchMidi: number) =>
    setNotes((prev) => sortByTime(prev.map((note) => note.id === id
      ? { ...note, startTimeSeconds: Math.max(0, startTimeSeconds), pitchMidi: clampPitch(pitchMidi) }
      : note)))

  const resizeNote = (id: number, durationSeconds: number) =>
    setNotes((prev) => prev.map((note) => note.id === id
      ? { ...note, durationSeconds: Math.max(0.05, durationSeconds) }
      : note))

  const addNote = (startTimeSeconds: number, pitchMidi: number) => {
    beginEdit()
    const id = (noteIdRef.current += 1)
    setNotes((prev) => sortByTime([...prev, { id, pitchMidi: clampPitch(pitchMidi), startTimeSeconds: Math.max(0, startTimeSeconds), durationSeconds: 0.35, amplitude: 0.75 }]))
    setSelectedId(id)
  }

  const deleteNote = (id: number) => {
    beginEdit()
    setNotes((prev) => prev.filter((note) => note.id !== id))
    setSelectedId((current) => (current === id ? null : current))
  }

  const undo = () => {
    if (!history.length) return
    if (isPlaying) stopPlayback(false)
    setNotes(history[history.length - 1])
    setHistory((stack) => stack.slice(0, -1))
    setSelectedId(null)
  }

  const restoreOriginal = () => {
    beginEdit()
    setNotes(originalNotes)
    setSelectedId(null)
    setMessage('처음 인식된 상태로 되돌렸어요.')
  }

  // 음정 자동 보정: 모든 음을 선택한 조성/음계의 가장 가까운 음으로 스냅.
  const applyScaleSnap = () => {
    if (!notes.length) return
    beginEdit()
    const steps = SCALES[scaleType].steps
    setNotes((prev) => prev.map((note) => ({ ...note, pitchMidi: snapPitchToScale(note.pitchMidi, scaleRoot, steps) })))
    setSelectedId(null)
    setMessage(`${PITCH_NAMES[scaleRoot]} ${SCALES[scaleType].label}로 음정을 정리했어요.`)
  }

  // 박자 자동 보정: 시작 위치와 길이를 BPM/그리드에 맞춰 정렬(퀀타이즈).
  const applyQuantize = () => {
    if (!notes.length) return
    beginEdit()
    const step = (60 / Math.max(30, bpm)) * GRIDS[gridDivision].beats
    setNotes((prev) => sortByTime(prev.map((note) => ({
      ...note,
      startTimeSeconds: Math.round(note.startTimeSeconds / step) * step,
      durationSeconds: Math.max(step, Math.round(note.durationSeconds / step) * step),
    }))))
    setSelectedId(null)
    setMessage(`${bpm} BPM · ${GRIDS[gridDivision].label} 그리드로 박자를 맞췄어요.`)
  }

  // 이상치 제거: 주변 멜로디에서 과도하게 엇나가는 음을 찾아 삭제.
  const removeOutliers = () => {
    if (notes.length < 3) {
      setMessage('이상치를 판단하려면 음이 3개 이상 필요해요.')
      return
    }
    const outliers = findPitchOutliers(notes, outlierThreshold)
    if (!outliers.size) {
      setMessage('과도하게 엇나가는 음을 찾지 못했어요.')
      return
    }
    beginEdit()
    setNotes((prev) => prev.filter((note) => !outliers.has(note.id)))
    setSelectedId((current) => (current !== null && outliers.has(current) ? null : current))
    setMessage(`엇나가는 음 ${outliers.size}개를 삭제했어요.`)
  }

  const downloadMidi = async () => {
    const { Midi } = await import('@tonejs/midi')
    const midi = new Midi()
    midi.header.name = 'HTI melody'
    const track = midi.addTrack()
    track.name = 'Humming melody'
    track.instrument.number = 0
    notes.forEach((note) => track.addNote({
      midi: note.pitchMidi,
      time: note.startTimeSeconds,
      duration: note.durationSeconds,
      velocity: Math.min(1, Math.max(0.25, note.amplitude)),
    }))
    const blob = new Blob([midi.toArray().buffer as ArrayBuffer], { type: 'audio/midi' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `hti-${new Date().toISOString().slice(0, 10)}.mid`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const resetRecording = () => {
    stopPlayback(true)
    setRecordedBuffer(null)
    setNotes([])
    setHistory([])
    setSelectedId(null)
    setOriginalNotes([])
    setRecordingSeconds(0)
    setProgress(0)
    setAppState('idle')
    setMessage('버튼을 누르고 떠오른 멜로디를 불러보세요.')
  }

  // 선택한 음을 Delete/Backspace로 삭제 (입력 필드에 포커스가 있을 땐 무시)
  useEffect(() => {
    if (appState !== 'ready') return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId !== null) {
        event.preventDefault()
        deleteNote(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState, selectedId])

  useEffect(() => () => {
    cleanupRecording()
    stopPlayback()
    samplerRef.current?.dispose()
  }, [cleanupRecording, stopPlayback])

  return (
    <main>
      <nav className="nav-shell">
        <div className="brand"><span className="brand-mark"><Icon name="wave" size={17} /></span> HTI</div>
        <div className="local-badge"><span /> ON-DEVICE STUDIO</div>
      </nav>

      <section className="hero">
        <div className="eyebrow">VOICE → MIDI / 001</div>
        <h1>작곡을 가장 쉽게.<br/><em>나락락.</em></h1>
        <p>머릿속에만 있던 선율을 불러보세요.<br className="desktop-only"/> HTI가 음표로 옮겨드립니다.</p>
      </section>

      <section className="recorder-card">
        <div className="card-topline">
          <span>INPUT / MICROPHONE</span>
          <span className={`status ${appState}`}><i /> {appState === 'recording' ? 'RECORDING' : appState === 'converting' ? 'ANALYZING' : appState === 'ready' ? 'MIDI READY' : 'READY'}</span>
        </div>
        <div className="meter-wrap">
          <LevelMeter analyser={analyser} active={appState === 'recording'} />
          <div className="record-time">{formatTime(appState === 'recording' ? recordingSeconds : recordedBuffer?.duration ?? 0)} <small>/ 0:30</small></div>
        </div>
        <p className="recorder-message">{message}</p>
        <div className="action-row">
          {appState === 'recording' ? (
            <button className="primary record active" onClick={stopRecording}><Icon name="stop" /> 녹음 끝내기</button>
          ) : (
            <button className="primary record" onClick={startRecording} disabled={appState === 'converting'}><Icon name="mic" /> {recordedBuffer ? '다시 녹음하기' : '녹음 시작하기'}</button>
          )}
          <button className="primary convert" onClick={convertToMidi} disabled={!canConvert}>
            <Icon name="spark" /> {appState === 'converting' ? `변환 중 ${Math.round(progress * 100)}%` : 'MIDI로 변환'}
          </button>
        </div>
        {appState === 'converting' && <div className="conversion-progress"><span style={{ width: `${Math.max(3, progress * 100)}%` }} /></div>}
        {(appState === 'error' || appState === 'ready') && recordedBuffer && <button className="text-button" onClick={resetRecording}>처음부터 다시 시작</button>}
      </section>

      {appState === 'ready' && (
        <section className="studio-section">
          <div className="studio-heading">
            <div><span className="section-number">02</span><h2>MIDI STUDIO</h2><p>음표를 직접 다듬거나 자동으로 보정해 보세요.</p></div>
            <button className="download-button" onClick={downloadMidi} disabled={!notes.length}><Icon name="download" /> MIDI 받기</button>
          </div>

          <div className="edit-panel">
            <div className="edit-hint">
              <Icon name="spark" size={14} />
              <span>음을 <b>드래그</b>해 음정·위치 이동 · 오른쪽 끝을 끌어 <b>길이 조절</b> · 빈 곳 <b>더블클릭</b>으로 추가 · 음 <b>더블클릭</b>(또는 선택 후 Delete)으로 삭제</span>
            </div>
            <div className="edit-tools">
              <div className="tool-group">
                <label>음정 보정</label>
                <select value={scaleRoot} onChange={(event) => setScaleRoot(Number(event.target.value))} aria-label="조성 루트">
                  {PITCH_NAMES.map((name, value) => <option key={value} value={value}>{name}</option>)}
                </select>
                <select value={scaleType} onChange={(event) => setScaleType(event.target.value as ScaleType)} aria-label="음계">
                  {(Object.keys(SCALES) as ScaleType[]).map((key) => <option key={key} value={key}>{SCALES[key].label}</option>)}
                </select>
                <button className="tool-apply" onClick={applyScaleSnap} disabled={!notes.length}>적용</button>
              </div>
              <div className="tool-group">
                <label>박자 보정</label>
                <input className="bpm-input" type="number" min={40} max={240} value={bpm} onChange={(event) => setBpm(Math.min(240, Math.max(40, Number(event.target.value) || 0)))} aria-label="BPM" />
                <span className="tool-unit">BPM</span>
                <select value={gridDivision} onChange={(event) => setGridDivision(event.target.value as GridDivision)} aria-label="그리드">
                  {(Object.keys(GRIDS) as GridDivision[]).map((key) => <option key={key} value={key}>{GRIDS[key].label}</option>)}
                </select>
                <button className="tool-apply" onClick={applyQuantize} disabled={!notes.length}>적용</button>
              </div>
              <div className="tool-group">
                <label>이상치 제거</label>
                <select value={outlierThreshold} onChange={(event) => setOutlierThreshold(Number(event.target.value))} aria-label="이상치 기준">
                  {OUTLIER_THRESHOLDS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <button className="tool-apply" onClick={removeOutliers} disabled={notes.length < 3}>정리</button>
              </div>
              <div className="tool-group tool-group-end">
                <button className="tool-ghost" onClick={undo} disabled={!history.length}>되돌리기</button>
                <button className="tool-ghost" onClick={restoreOriginal} disabled={!originalNotes.length}>원본 복원</button>
              </div>
            </div>
          </div>

          <div className="daw-shell">
            <div className="daw-toolbar">
              <div className="window-dots"><span/><span/><span/></div>
              <div className="track-title"><b>TRACK 01</b><span>Humming melody</span></div>
              <div className="daw-meta"><span>{notes.length} NOTES</span><span>{formatTime(midiDuration)}</span></div>
            </div>
            {notes.length ? (
              <PianoRoll
                notes={notes}
                duration={midiDuration}
                position={position}
                editable
                selectedId={selectedId}
                onSelect={setSelectedId}
                onEditStart={beginEdit}
                onMoveNote={moveNote}
                onResizeNote={resizeNote}
                onAddNote={addNote}
                onDeleteNote={deleteNote}
              />
            ) : (
              <div className="empty-roll"><Icon name="wave" size={36}/><p>인식된 음표가 없습니다.</p><span>주변 소음을 줄이고 한 음씩 또렷하게 불러보세요.</span></div>
            )}
            <div className="transport">
              <button className="play-button" onClick={togglePlayback} disabled={!notes.length} aria-label={isPlaying ? '일시정지' : '재생'}><Icon name={isPlaying ? 'pause' : 'play'} size={23}/></button>
              <span className="time-current">{formatTime(position)}</span>
              <input type="range" min="0" max={Math.max(midiDuration, 0.01)} step="0.01" value={Math.min(position, midiDuration)} onChange={(event) => seek(Number(event.target.value))} style={{ '--range-progress': `${(position / Math.max(midiDuration, .01)) * 100}%` } as React.CSSProperties} aria-label="재생 위치" />
              <span className="time-total">{formatTime(midiDuration)}</span>
              <div className="instrument-label"><i /> GRAND PIANO</div>
            </div>
          </div>
        </section>
      )}

      <footer><span>BUILT FOR IDEAS IN MOTION</span><span>YOUR AUDIO NEVER LEAVES THIS DEVICE</span></footer>
    </main>
  )
}

export default App
