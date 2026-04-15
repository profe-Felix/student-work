import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

type Answer = 'greater' | 'less' | 'equal'

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function makeComparisonPair() {
  const mode = pickOne(['far', 'close', 'equal'] as const)

  let teacher = 0
  let student = 0

  if (mode === 'equal') {
    teacher = randInt(0, 20)
    student = teacher
  } else if (mode === 'far') {
    teacher = randInt(0, 20)
    do {
      student = randInt(0, 20)
    } while (Math.abs(teacher - student) < 4)
  } else {
    teacher = randInt(0, 19)
    const diff = pickOne([1, 2, 3])
    student = Math.min(20, teacher + diff)
    if (Math.random() < 0.5) [teacher, student] = [student, teacher]
  }

  return { teacher, student, mode }
}

function compareStudentToTeacher(student: number, teacher: number): Answer {
  if (student > teacher) return 'greater'
  if (student < teacher) return 'less'
  return 'equal'
}

function Frame10({ value }: { value: number }) {
  const cells = Array.from({ length: 10 }, (_, i) => i)
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 10,
        background: '#fff',
        border: '4px solid #334155',
        borderRadius: 16,
        padding: 12,
        width: 'min(92vw, 340px)',
        boxSizing: 'border-box',
      }}
    >
      {cells.map((i) => {
        const filled = i < value
        return (
          <div
            key={i}
            style={{
              aspectRatio: '1 / 1',
              borderRadius: 12,
              border: '3px solid #94a3b8',
              background: filled ? '#2563eb' : '#ffffff',
              boxSizing: 'border-box',
            }}
          />
        )
      })}
    </div>
  )
}

function DoubleTenFrame({ value, title }: { value: number; title: string }) {
  const top = Math.min(value, 10)
  const bottom = Math.max(0, value - 10)

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.88)',
        borderRadius: 28,
        padding: 20,
        boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
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

      <Frame10 value={top} />
      <Frame10 value={bottom} />

      <div
        style={{
          fontSize: 22,
          fontWeight: 900,
          color: '#1f2937',
          background: '#ffffff',
          borderRadius: 14,
          padding: '8px 14px',
        }}
      >
        {value}
      </div>
    </div>
  )
}

function BigChoiceButton({
  label,
  symbol,
  selected,
  onClick,
}: {
  label: string
  symbol: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        border: selected ? '5px solid #2563eb' : '4px solid #cbd5e1',
        background: selected ? '#dbeafe' : '#ffffff',
        color: '#1f2937',
        borderRadius: 28,
        padding: '20px 16px',
        minWidth: 180,
        cursor: 'pointer',
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

  const teacherParam = searchParams.get('t')
  const studentParam = searchParams.get('s')
  
  const teacherValue = teacherParam === null ? null : Number(teacherParam)
  const studentValue = studentParam === null ? null : Number(studentParam)
  
  const initialPair = useMemo(() => {
    const hasTeacher = teacherValue !== null && Number.isFinite(teacherValue)
    const hasStudent = studentValue !== null && Number.isFinite(studentValue)
  
    // TEACHER MODE → normal behavior
    if (role === 'teacher') {
      if (hasTeacher && hasStudent) {
        return {
          teacher: teacherValue as number,
          student: studentValue as number,
        }
      }
      return makeComparisonPair()
    }
  
    // STUDENT MODE → shared teacher, unique student
    if (hasTeacher) {
      return {
        teacher: teacherValue as number,
        student: randInt(0, 20), // 🔥 each device gets different number
      }
    }
  
    return makeComparisonPair()
  }, [role, teacherValue, studentValue])

  const [teacher, setTeacher] = useState(initialPair.teacher)
  const [student, setStudent] = useState(initialPair.student)
  const [selected, setSelected] = useState<Answer | null>(null)
  const [revealed, setRevealed] = useState(false)

  const correct = compareStudentToTeacher(student, teacher)

  function updateUrl(nextTeacher: number, nextStudent: number, nextRole = role) {
    setSearchParams({
      role: nextRole,
      t: String(nextTeacher),
      s: String(nextStudent),
    })
  }

  function nextRound() {
    const next = makeComparisonPair()
    setTeacher(next.teacher)
    setStudent(next.student)
    setSelected(null)
    setRevealed(false)
    updateUrl(next.teacher, next.student, role)
  }

  const teacherLink = `https://profe-felix.github.io/student-work/#/ws/ten-frame-compare?role=teacher&t=${teacher}&s=${student}`
  const studentLink = `https://profe-felix.github.io/student-work/#/ws/ten-frame-compare?role=student&t=${teacher}`

  if (role === 'student') {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'linear-gradient(180deg, #dbeafe 0%, #e0f2fe 55%, #dcfce7 100%)',
          padding: 16,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ maxWidth: 1000, margin: '0 auto' }}>
          <div
            style={{
              textAlign: 'center',
              fontSize: 40,
              fontWeight: 900,
              color: '#166534',
              marginBottom: 8,
            }}
          >
            Compare My Ten Frame
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
            My ten frame is…
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
            <DoubleTenFrame value={student} title="My Ten Frame" />
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
              onClick={() => {
                setSelected('greater')
                setRevealed(true)
              }}
            />
            <BigChoiceButton
              label="Less"
              symbol="<"
              selected={selected === 'less'}
              onClick={() => {
                setSelected('less')
                setRevealed(true)
              }}
            />
            <BigChoiceButton
              label="Equal"
              symbol="="
              selected={selected === 'equal'}
              onClick={() => {
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
                {selected === correct ? 'Correct!' : 'Try Again'}
              </div>

              <div
                style={{
                  fontSize: 24,
                  color: '#374151',
                  fontWeight: 700,
                }}
              >
                My ten frame is <span style={{ color: '#2563eb' }}>{correct}</span> than the teacher’s ten frame.
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
            Next Round
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
          Project your frame. Students open their link and compare theirs to yours.
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 20,
            alignItems: 'start',
          }}
        >
          <DoubleTenFrame value={teacher} title="Teacher Frame" />
          <DoubleTenFrame value={student} title="Student Frame" />
        </div>

        <div
          style={{
            marginTop: 20,
            background: '#ffffff',
            borderRadius: 22,
            padding: 18,
            boxShadow: '0 10px 30px rgba(0,0,0,0.10)',
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 22, marginBottom: 10, color: '#1f2937' }}>
            Current links
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>Teacher link</div>
            <div style={{ wordBreak: 'break-all', color: '#334155' }}>{teacherLink}</div>
          </div>

          <div>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>Student link</div>
            <div style={{ wordBreak: 'break-all', color: '#334155' }}>{studentLink}</div>
          </div>

          <div
            style={{
              marginTop: 14,
              fontSize: 20,
              fontWeight: 800,
              color: '#2563eb',
            }}
          >
            Correct answer: Student is {correct} than teacher
          </div>
        </div>
      </div>
    </div>
  )
}
