import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

type Answer = 'greater' | 'less' | 'equal'
type DisplayMode = 'tenframe' | 'numeral'

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pickOne<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function compareStudentToTeacher(student: number, teacher: number): Answer {
  if (student > teacher) return 'greater'
  if (student < teacher) return 'less'
  return 'equal'
}

function hashString(str: string) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededInt(seedStr: string, min: number, max: number) {
  const rng = mulberry32(hashString(seedStr))
  return Math.floor(rng() * (max - min + 1)) + min
}

function seededPick<T>(seedStr: string, arr: readonly T[]): T {
  const rng = mulberry32(hashString(seedStr))
  return arr[Math.floor(rng() * arr.length)]
}

function seededShuffle(arr: number[], seed: number) {
  const a = [...arr]
  let s = seed >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    s = ((s ^ (s << 13)) ^ (s >> 7) ^ (s << 17)) >>> 0
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function getOrCreateDeviceId() {
  if (typeof window === 'undefined') return 'server'

  const key = 'ten-frame-compare-device-id'
  const existing = window.localStorage.getItem(key)
  if (existing) return existing

  const fresh = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  window.localStorage.setItem(key, fresh)
  return fresh
}

function makeTeacherRound() {
  return {
    teacher: randInt(0, 20),
    round: Date.now(),
    teacherDisplay: pickOne<DisplayMode>(['tenframe', 'numeral']),
  }
}

function computeStudentValue(teacher: number, round: number, deviceId: string) {
  const mode = seededPick(`${deviceId}-${teacher}-${round}-mode`, ['far', 'close', 'equal'] as const)

  if (mode === 'equal') return teacher

  if (mode === 'far') {
    let tries = 0
    while (tries < 25) {
      const candidate = seededInt(`${deviceId}-${teacher}-${round}-far-${tries}`, 0, 20)
      if (Math.abs(candidate - teacher) >= 4) return candidate
      tries++
    }
    return teacher <= 10 ? Math.min(20, teacher + 5) : Math.max(0, teacher - 5)
  }

  const diff = seededPick(`${deviceId}-${teacher}-${round}-diff`, [1, 2, 3] as const)
  const direction = seededPick(`${deviceId}-${teacher}-${round}-dir`, ['up', 'down'] as const)

  let candidate =
    direction === 'up'
      ? Math.min(20, teacher + diff)
      : Math.max(0, teacher - diff)

  if (candidate === teacher) {
    candidate = teacher < 20 ? teacher + 1 : teacher - 1
  }

  return candidate
}

function Frame10({ value, seed }: { value: number; seed: number }) {
  const positions = Array.from({ length: 10 }, (_, i) => i)
  const shuffled = seededShuffle(positions, seed)
  const filledPositions = new Set(shuffled.slice(0, value))

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 8,
        border: '3px solid #1f2937',
        borderRadius: 12,
        padding: 8,
        background: '#ffffff',
      }}
    >
      {positions.map((i) => {
        const filled = filledPositions.has(i)
        return (
          <div
            key={i}
            style={{
              width: 42,
              height: 42,
              border: '2px solid #9ca3af',
              background: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 8,
              boxSizing: 'border-box',
            }}
          >
            {filled ? (
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '999px',
                  background: '#111827',
                }}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function DoubleTenFrame({
  value,
  title,
  seedBase,
}: {
  value: number
  title: string
  seedBase: number
}) {
  const top = Math.min(value, 10)
  const bottom = Math.max(0, value - 10)

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.9)',
        borderRadius: 28,
        padding: 20,
        boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
        minWidth: 300,
      }}
    >
      <div
        style={{
          fontSize: 30,
          fontWeight: 900,
          color: '#166534',
          textAlign: 'center',
        }}
      >
        {title}
      </div>

      <Frame10 value={top} seed={seedBase + 11} />
      <Frame10 value={bottom} seed={seedBase + 29} />
    </div>
  )
}

function NumeralCard({ value, title }: { value: number; title: string }) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.9)',
        borderRadius: 28,
        padding: 24,
        boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
        minWidth: 300,
      }}
    >
      <div
        style={{
          fontSize: 30,
          fontWeight: 900,
          color: '#166534',
          textAlign: 'center',
        }}
      >
        {title}
      </div>

      <div
        style={{
          minWidth: 180,
          minHeight: 180,
          borderRadius: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#ffffff',
          border: '5px solid #334155',
          fontSize: 96,
          fontWeight: 900,
          color: '#1d4ed8',
          lineHeight: 1,
          padding: 16,
        }}
      >
        {value}
      </div>
    </div>
  )
}

function RepresentationCard({
  value,
  title,
  display,
  seedBase,
}: {
  value: number
  title: string
  display: DisplayMode
  seedBase: number
}) {
  if (display === 'numeral') {
    return <NumeralCard value={value} title={title} />
  }

  return <DoubleTenFrame value={value} title={title} seedBase={seedBase} />
}

function BigChoiceButton({
  label,
  symbol,
  disabled,
  selected,
  onClick,
}: {
  label: string
  symbol: string
  disabled: boolean
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: selected ? '5px solid #2563eb' : '4px solid #cbd5e1',
        background: selected ? '#dbeafe' : '#ffffff',
        color: '#1f2937',
        borderRadius: 28,
        padding: '20px 16px',
        minWidth: 180,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled && !selected ? 0.65 : 1,
        boxShadow: '0 8px 20px rgba(0,0,0,0.08)',
        fontWeight: 900,
      }}
    >
      <div style={{ fontSize: 54, lineHeight: 1, marginBottom: 10 }}>{symbol}</div>
      <div style={{ fontSize: 26 }}>{label}</div>
    </button>
  )
}

export default function TenFrameCompareWS() {
  const [searchParams, setSearchParams] = useSearchParams()
  const role = searchParams.get('role') || 'teacher'

  const [deviceId, setDeviceId] = useState('boot')

  const teacherRaw = searchParams.get('t')
  const roundRaw = searchParams.get('round')
  const teacherDisplayRaw = searchParams.get('td')

  const teacherFromUrl =
    teacherRaw !== null && teacherRaw.trim() !== '' ? Number(teacherRaw) : NaN
  const roundFromUrl =
    roundRaw !== null && roundRaw.trim() !== '' ? Number(roundRaw) : NaN

  const teacherDisplayFromUrl: DisplayMode =
    teacherDisplayRaw === 'numeral' ? 'numeral' : 'tenframe'

  const hasValidTeacherState =
    Number.isFinite(teacherFromUrl) &&
    teacherFromUrl >= 0 &&
    teacherFromUrl <= 20 &&
    Number.isFinite(roundFromUrl) &&
    roundFromUrl > 0

  const [selected, setSelected] = useState<Answer | null>(null)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    setDeviceId(getOrCreateDeviceId())
  }, [])

  useEffect(() => {
    if (role !== 'teacher') return
    if (hasValidTeacherState) return

    const fresh = makeTeacherRound()
    setSearchParams(
      {
        role: 'teacher',
        t: String(fresh.teacher),
        round: String(fresh.round),
        td: fresh.teacherDisplay,
      },
      { replace: true }
    )
  }, [role, hasValidTeacherState, setSearchParams])

  useEffect(() => {
    setSelected(null)
    setRevealed(false)
  }, [roundFromUrl])

  const teacher = hasValidTeacherState ? teacherFromUrl : 0
  const round = hasValidTeacherState ? roundFromUrl : 0
  const teacherDisplay: DisplayMode = teacherDisplayFromUrl

  const student = useMemo(() => {
    if (!hasValidTeacherState) return 0
    if (deviceId === 'boot') return 0
    return computeStudentValue(teacher, round, deviceId)
  }, [hasValidTeacherState, teacher, round, deviceId])

  const studentDisplay = useMemo<DisplayMode>(() => {
    if (!hasValidTeacherState) return 'tenframe'
    if (deviceId === 'boot') return 'tenframe'
    return seededPick<DisplayMode>(
      `${deviceId}-${teacher}-${round}-student-display`,
      ['tenframe', 'numeral']
    )
  }, [hasValidTeacherState, deviceId, teacher, round])

  const correct = compareStudentToTeacher(student, teacher)

  function nextRound() {
    const fresh = makeTeacherRound()
    setSearchParams({
      role: 'teacher',
      t: String(fresh.teacher),
      round: String(fresh.round),
      td: fresh.teacherDisplay,
    })
  }

  const teacherLink =
    `https://profe-felix.github.io/student-work/#/ws/ten-frame-compare` +
    `?role=teacher&t=${teacher}&round=${round}&td=${teacherDisplay}`

  const studentLink =
    `https://profe-felix.github.io/student-work/#/ws/ten-frame-compare` +
    `?role=student&t=${teacher}&round=${round}&td=${teacherDisplay}`

  if (role === 'teacher' && !hasValidTeacherState) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(180deg, #ede9fe 0%, #dbeafe 50%, #dcfce7 100%)',
          padding: 16,
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            background: '#ffffff',
            borderRadius: 24,
            padding: 24,
            fontSize: 24,
            fontWeight: 800,
            color: '#374151',
            boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
          }}
        >
          Loading round…
        </div>
      </div>
    )
  }

  if (role === 'student' && !hasValidTeacherState) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(180deg, #dbeafe 0%, #e0f2fe 55%, #dcfce7 100%)',
          padding: 16,
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            maxWidth: 760,
            background: '#ffffff',
            borderRadius: 24,
            padding: 24,
            textAlign: 'center',
            boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
          }}
        >
          <div
            style={{
              fontSize: 34,
              fontWeight: 900,
              color: '#166534',
              marginBottom: 12,
            }}
          >
            Waiting for teacher link
          </div>

          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: '#374151',
            }}
          >
            Open the student link copied from the teacher page.
          </div>
        </div>
      </div>
    )
  }

  if (role === 'student' && deviceId === 'boot') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(180deg, #dbeafe 0%, #e0f2fe 55%, #dcfce7 100%)',
          padding: 16,
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            background: '#ffffff',
            borderRadius: 24,
            padding: 24,
            fontSize: 24,
            fontWeight: 800,
            color: '#374151',
            boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
          }}
        >
          Loading round…
        </div>
      </div>
    )
  }

  if (role === 'student') {
    const answerLocked = revealed

    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'linear-gradient(180deg, #dbeafe 0%, #e0f2fe 55%, #dcfce7 100%)',
          padding: 16,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div
            style={{
              textAlign: 'center',
              fontSize: 40,
              fontWeight: 900,
              color: '#166534',
              marginBottom: 8,
            }}
          >
            Compare My Number
          </div>

          <div
            style={{
              textAlign: 'center',
              fontSize: 24,
              color: '#374151',
              marginBottom: 18,
              fontWeight: 700,
            }}
          >
            My number is greater than, less than, or equal to the teacher&apos;s number.
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 20,
              flexWrap: 'wrap',
              marginBottom: 24,
            }}
          >
            <RepresentationCard
              value={student}
              title="My Number"
              display={studentDisplay}
              seedBase={hashString(`student-${student}-${round}`)}
            />

            <RepresentationCard
              value={teacher}
              title="Teacher Number"
              display={teacherDisplay}
              seedBase={hashString(`teacher-${teacher}-${round}`)}
            />
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 16,
              flexWrap: 'wrap',
              marginBottom: 20,
            }}
          >
            <BigChoiceButton
              label="Greater"
              symbol=">"
              selected={selected === 'greater'}
              disabled={answerLocked}
              onClick={() => {
                if (answerLocked) return
                setSelected('greater')
                setRevealed(true)
              }}
            />
            <BigChoiceButton
              label="Less"
              symbol="<"
              selected={selected === 'less'}
              disabled={answerLocked}
              onClick={() => {
                if (answerLocked) return
                setSelected('less')
                setRevealed(true)
              }}
            />
            <BigChoiceButton
              label="Equal"
              symbol="="
              selected={selected === 'equal'}
              disabled={answerLocked}
              onClick={() => {
                if (answerLocked) return
                setSelected('equal')
                setRevealed(true)
              }}
            />
          </div>

          {revealed && selected && (
            <div
              style={{
                maxWidth: 760,
                margin: '0 auto',
                background: '#ffffff',
                borderRadius: 24,
                padding: 20,
                textAlign: 'center',
                boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
              }}
            >
              <div
                style={{
                  fontSize: 34,
                  fontWeight: 900,
                  color: selected === correct ? '#16a34a' : '#dc2626',
                  marginBottom: 10,
                }}
              >
                {selected === correct ? 'Correct!' : 'Not this round'}
              </div>

              <div
                style={{
                  fontSize: 22,
                  color: '#374151',
                  fontWeight: 700,
                }}
              >
                Wait for the teacher to start a new round.
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #ede9fe 0%, #dbeafe 50%, #dcfce7 100%)',
        padding: 16,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 12,
            flexWrap: 'wrap',
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
            Start New Round
          </button>

          <button
            onClick={() => navigator.clipboard.writeText(studentLink)}
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
            Copy Student Link
          </button>

          <button
            onClick={() => navigator.clipboard.writeText(teacherLink)}
            style={{
              border: 0,
              borderRadius: 16,
              padding: '14px 22px',
              fontWeight: 900,
              fontSize: 18,
              background: '#7c3aed',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Copy Teacher Link
          </button>
        </div>

        <div
          style={{
            textAlign: 'center',
            fontSize: 38,
            fontWeight: 900,
            color: '#166534',
            marginBottom: 8,
          }}
        >
          Ten Frame Compare — Teacher
        </div>

        <div
          style={{
            textAlign: 'center',
            fontSize: 20,
            color: '#374151',
            marginBottom: 18,
            fontWeight: 700,
          }}
        >
          Project your number. Students compare theirs to yours.
        </div>

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <RepresentationCard
            value={teacher}
            title="Teacher Number"
            display={teacherDisplay}
            seedBase={hashString(`teacher-${teacher}-${round}`)}
          />
        </div>

        <div
          style={{
            marginTop: 20,
            background: '#ffffff',
            borderRadius: 22,
            padding: 18,
            boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
            textAlign: 'center',
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 22, marginBottom: 10, color: '#1f2937' }}>
            Links ready
          </div>

          <div style={{ color: '#334155', fontSize: 18, fontWeight: 700 }}>
            Use the buttons above to copy the teacher and student links.
          </div>
        </div>
      </div>
    </div>
  )
}
