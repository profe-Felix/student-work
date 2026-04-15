import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

type Difficulty = 'far' | 'close' | 'equal'
type Answer = 'greater' | 'less' | 'equal'

type RoundData = {
  left: number
  right: number
  leftSeed: number
  rightSeed: number
  difficulty: Difficulty
  answer: Answer
  showAnswer: boolean
}

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffleWithSeed<T>(arr: T[], seed: number): T[] {
  const out = [...arr]
  const rand = mulberry32(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function randInt(min: number, max: number, rand = Math.random) {
  return Math.floor(rand() * (max - min + 1)) + min
}

function randomSeed() {
  return Math.floor(Math.random() * 1000000)
}

function makePair(type: Difficulty): Omit<RoundData, 'showAnswer'> {
  let left = 0
  let right = 0

  if (type === 'equal') {
    left = randInt(0, 20)
    right = left
  } else if (type === 'far') {
    left = randInt(0, 20)
    do {
      right = randInt(0, 20)
    } while (Math.abs(left - right) < 4)
  } else {
    left = randInt(0, 19)
    const diff = [1, 2, 3][randInt(0, 2)]
    right = Math.min(20, left + diff)
    if (Math.random() < 0.5) [left, right] = [right, left]
  }

  let answer: Answer = 'equal'
  if (left > right) answer = 'greater'
  else if (left < right) answer = 'less'

  return {
    left,
    right,
    leftSeed: randomSeed(),
    rightSeed: randomSeed(),
    difficulty: type,
    answer,
  }
}

function buildRoundFromQuery(searchParams: URLSearchParams): RoundData | null {
  const left = Number(searchParams.get('l'))
  const right = Number(searchParams.get('r'))
  const leftSeed = Number(searchParams.get('ls'))
  const rightSeed = Number(searchParams.get('rs'))
  const difficulty = (searchParams.get('d') || '') as Difficulty
  const answer = (searchParams.get('a') || '') as Answer
  const showAnswer = searchParams.get('show') === '1'

  const ok =
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Number.isFinite(leftSeed) &&
    Number.isFinite(rightSeed) &&
    ['far', 'close', 'equal'].includes(difficulty) &&
    ['greater', 'less', 'equal'].includes(answer)

  if (!ok) return null

  return { left, right, leftSeed, rightSeed, difficulty, answer, showAnswer }
}

function writeRoundToQuery(round: RoundData, setSearchParams: ReturnType<typeof useSearchParams>[1]) {
  setSearchParams({
    l: String(round.left),
    r: String(round.right),
    ls: String(round.leftSeed),
    rs: String(round.rightSeed),
    d: round.difficulty,
    a: round.answer,
    show: round.showAnswer ? '1' : '0',
  })
}

function DotFrame({
  value,
  seed,
  label,
}: {
  value: number
  seed: number
  label: string
}) {
  const filled = useMemo(() => {
    const order = shuffleWithSeed(
      Array.from({ length: 20 }, (_, i) => i),
      seed
    )
    return new Set(order.slice(0, value))
  }, [value, seed])

  const cells = Array.from({ length: 20 }, (_, i) => i)

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 24,
        padding: 20,
        boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
        border: '2px solid #dbeafe',
      }}
    >
      <div
        style={{
          textAlign: 'center',
          fontWeight: 900,
          fontSize: 28,
          color: '#1d4ed8',
          marginBottom: 12,
        }}
      >
        {label}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 10,
          maxWidth: 340,
          margin: '0 auto',
        }}
      >
        {cells.map((i) => {
          const isFilled = filled.has(i)
          const isDivider = i === 10
          return (
            <div
              key={i}
              style={{
                width: 46,
                height: 46,
                borderRadius: '999px',
                background: isFilled ? '#2563eb' : '#e5e7eb',
                border: '3px solid #94a3b8',
                marginTop: isDivider ? 10 : 0,
                justifySelf: 'center',
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

export default function TenFrameCompareWS() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [roundIndex, setRoundIndex] = useState(0)

  const [round, setRound] = useState<RoundData>(() => {
    const fromQuery = buildRoundFromQuery(new URLSearchParams(window.location.search))
    if (fromQuery) return fromQuery
    return {
      ...makePair('far'),
      showAnswer: false,
    }
  })

  useEffect(() => {
    const fromQuery = buildRoundFromQuery(searchParams)
    if (fromQuery) {
      setRound(fromQuery)
      return
    }
    writeRoundToQuery(round, setSearchParams)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const nextRound = () => {
    const sequence: Difficulty[] = ['far', 'far', 'close', 'close', 'equal', 'close', 'far', 'equal']
    const difficulty = sequence[roundIndex % sequence.length]
    const next: RoundData = {
      ...makePair(difficulty),
      showAnswer: false,
    }
    setRound(next)
    setRoundIndex((n) => n + 1)
    writeRoundToQuery(next, setSearchParams)
  }

  const toggleAnswer = () => {
    const next = { ...round, showAnswer: !round.showAnswer }
    setRound(next)
    writeRoundToQuery(next, setSearchParams)
  }

  const revealText =
    round.answer === 'greater'
      ? 'The left frame is greater than the right frame.'
      : round.answer === 'less'
      ? 'The left frame is less than the right frame.'
      : 'The two frames are equal.'

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #dbeafe 0%, #e0f2fe 55%, #dcfce7 100%)',
        padding: 16,
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            justifyContent: 'center',
            marginBottom: 16,
          }}
        >
          <button
            onClick={nextRound}
            style={{
              border: 0,
              borderRadius: 16,
              padding: '14px 22px',
              fontWeight: 900,
              fontSize: 18,
              background: '#16a34a',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Next Round
          </button>

          <button
            onClick={toggleAnswer}
            style={{
              border: 0,
              borderRadius: 16,
              padding: '14px 22px',
              fontWeight: 900,
              fontSize: 18,
              background: '#2563eb',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            {round.showAnswer ? 'Hide Answer' : 'Show Answer'}
          </button>
        </div>

        <div
          style={{
            textAlign: 'center',
            fontWeight: 900,
            fontSize: 40,
            color: '#166534',
            marginBottom: 8,
          }}
        >
          Compare the Ten Frames
        </div>

        <div
          style={{
            textAlign: 'center',
            fontSize: 18,
            color: '#374151',
            marginBottom: 18,
          }}
        >
          Choose: greater than, less than, or equal to
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 20,
            alignItems: 'start',
          }}
        >
          <DotFrame value={round.left} seed={round.leftSeed} label="Left" />
          <DotFrame value={round.right} seed={round.rightSeed} label="Right" />
        </div>

        <div
          style={{
            marginTop: 18,
            display: 'flex',
            justifyContent: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              background: 'rgba(255,255,255,0.85)',
              borderRadius: 16,
              padding: '10px 16px',
              fontWeight: 800,
            }}
          >
            Difficulty: {round.difficulty}
          </div>

          <div
            style={{
              background: 'rgba(255,255,255,0.85)',
              borderRadius: 16,
              padding: '10px 16px',
              fontWeight: 800,
            }}
          >
            Shared link updates automatically
          </div>
        </div>

        {round.showAnswer && (
          <div
            style={{
              marginTop: 20,
              background: '#ffffff',
              borderRadius: 20,
              padding: 20,
              textAlign: 'center',
              boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
            }}
          >
            <div
              style={{
                fontWeight: 900,
                fontSize: 28,
                color: '#7c3aed',
                marginBottom: 8,
              }}
            >
              Answer: {round.answer}
            </div>
            <div style={{ fontSize: 20, color: '#374151' }}>{revealText}</div>
          </div>
        )}
      </div>
    </div>
  )
}
