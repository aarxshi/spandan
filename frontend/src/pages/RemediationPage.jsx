import React, { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import useAuthStore from '../stores/authStore'
import { API_URL } from '../config.js'
import Sidebar from '../components/Sidebar'
import { PageHeader, Pill, pageWash, primaryButton } from '../components/AppUI'
import { StatTile, TileGrid, cardStyle } from '../components/InsightUI'
import { Ico } from '../components/icons'
import useIsMobile from '../hooks/useIsMobile'
import { ChartColumn, Check, CircleCheck, RotateCcw, TriangleAlert, X } from 'lucide-react'

// Decode HTML entities from LLM output
const decodeHtml = (text) => {
  if (!text) return ''
  const doc = new DOMParser().parseFromString(text, 'text/html')
  return doc.documentElement.textContent
}

// Theme-aware colour helpers (same recipe as the rest of the app): a translucent tint of a colour for
// backgrounds, and a tone lifted toward white in dark mode (--tone-lift) for text.
const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`
const tone = (c) => `color-mix(in srgb, ${c}, white var(--tone-lift))`

function RemediationPage() {
  const { roomId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const maxQuestions = parseInt(searchParams.get('max') ?? '2')
  const { user, token } = useAuthStore()
  const isMobile = useIsMobile()

  const [questions, setQuestions] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selectedOption, setSelectedOption] = useState(null)
  // Answers are saved to the server as the student goes, but feedback (correct answer + explanation)
  // is held back until every question is answered, then shown together in the 'review' phase.
  const [answers, setAnswers] = useState([]) // one entry per question, in order
  const [phase, setPhase] = useState('answering') // 'answering' | 'review'
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [failedCount, setFailedCount] = useState(0)
  const [timeLeft, setTimeLeft] = useState(30)
  const timerRef = useRef(null)
  const startTimeRef = useRef(null)
  const submittingRef = useRef(false)

  useEffect(() => {
    fetchRemediationQuestions()
  }, [roomId])

  useEffect(() => {
    if (questions.length > 0 && phase === 'answering') {
      startTimer()
    }
    return () => clearInterval(timerRef.current)
  }, [currentIndex, questions, phase])

  const startTimer = () => {
    clearInterval(timerRef.current)
    const tta = questions[currentIndex]?.timeToAnswer || 30
    setTimeLeft(tta)
    startTimeRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current)
          // Auto-submit with no selection if timer runs out
          handleSubmit(null, true)
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  const fetchRemediationQuestions = async () => {
    setIsLoading(true)
    try {
      const res = await fetch(`${API_URL}/remediation/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ roomId, maxQuestions })
      })
      const data = await res.json()
      if (!res.ok) {
        // A non-2xx (403 not a member, 404 room not found, 500, etc.) still parses as valid JSON
        // here, so without this check it silently fell into the "no remediation" branch below and
        // redirected to results with zero indication anything went wrong — looked exactly like a
        // random glitch instead of a real, diagnosable server error.
        console.error('[remediation] /generate failed:', res.status, data?.error || data)
        setError(data?.error || `Failed to load remediation questions (${res.status})`)
        return
      }
      if (data.success && data.questions.length > 0) {
        setQuestions(data.questions)
        setFailedCount(data.failedCount || 0)
      } else {
        // No remediation needed — go straight to results
        navigate(`/student/room/${roomId}/results`)
      }
    } catch (err) {
      setError('Failed to load remediation questions')
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (optionIdx, timedOut = false) => {
    if (submittingRef.current || phase !== 'answering') return
    submittingRef.current = true
    clearInterval(timerRef.current)
    setIsSubmitting(true)

    const question = questions[currentIndex]
    const responseTime = Math.round((Date.now() - startTimeRef.current) / 1000)
    // Time ran out with nothing chosen: send -1 (no option) so it is recorded as wrong, never as option A.
    const selectedIdx = timedOut ? -1 : optionIdx

    let entry
    try {
      const res = await fetch(`${API_URL}/remediation/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          roomId,
          questionId: question._id,
          selectedOptions: [selectedIdx],
          responseTime,
          timedOut
        })
      })
      const data = await res.json()
      entry = res.ok
        ? { ...data, selectedIdx, timedOut }
        : { selectedIdx, timedOut, error: data?.error || `Could not save this answer (${res.status})` }
    } catch (err) {
      console.error('Failed to submit remediation answer:', err)
      entry = { selectedIdx, timedOut, error: 'Could not save this answer' }
    }

    setAnswers(prev => [...prev, { questionIndex: currentIndex, ...entry }])
    setIsSubmitting(false)
    submittingRef.current = false

    // No feedback yet — move straight on. After the last question, show the review on this same page.
    if (currentIndex < questions.length - 1) {
      setCurrentIndex(prev => prev + 1)
      setSelectedOption(null)
    } else {
      setPhase('review')
    }
  }

  const goToResults = () => navigate(`/student/room/${roomId}/results`)
  // A slow generation can trip a proxy timeout (504) while the server keeps going; retrying just
  // picks up the finished question, so offer it instead of a dead end.
  const retryLoad = () => { setError(''); fetchRemediationQuestions() }

  // Same page chrome as every other student page: sidebar + blue header + softly washed content area.
  const shell = (body, subtitle) => (
    <div style={{
      display: 'flex',
      minHeight: '100vh',
      maxWidth: '100%',
      boxSizing: 'border-box',
      background: 'var(--bg-primary)',
      fontFamily: '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif'
    }}>
      <Sidebar user={user} />
      <div style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        marginLeft: 'var(--sidebar-width, 240px)',
        maxWidth: '100%',
        boxSizing: 'border-box'
      }}>
        <PageHeader isMobile={isMobile} icon={RotateCcw} eyebrow="Follow-up practice" title="Let's revisit what you missed" subtitle={subtitle} />
        <div style={{ flex: 1, background: pageWash, padding: isMobile ? '16px' : '32px', maxWidth: '100%', boxSizing: 'border-box' }}>
          <div style={{ maxWidth: '860px', margin: '0 auto' }}>{body}</div>
        </div>
      </div>
    </div>
  )

  if (isLoading) {
    return shell(
      <div style={{ ...cardStyle(isMobile), textAlign: 'center', padding: isMobile ? '40px 18px' : '56px 24px' }}>
        <div style={{
          width: '48px', height: '48px',
          border: '4px solid var(--border-color)',
          borderTopColor: 'var(--accent)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
          margin: '0 auto 16px'
        }} />
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '15px' }}>
          Preparing your personalised questions...
        </p>
        <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
      </div>,
      'Hang tight while we prepare your questions'
    )
  }

  if (error) {
    return shell(
      <div style={{ ...cardStyle(isMobile), textAlign: 'center' }}>
        <p style={{ margin: '0 0 16px', color: tone('#dc2626'), fontSize: '15px' }}>{error}</p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={retryLoad} style={primaryButton(false)}>Try again</button>
          <button onClick={goToResults} style={{ ...primaryButton(false), background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', boxShadow: 'none' }}>Go to results</button>
        </div>
      </div>,
      'Something went wrong'
    )
  }

  const question = questions[currentIndex]
  const tta = question?.timeToAnswer || 30
  const isReview = phase === 'review'
  const correctCount = answers.filter(a => a.isCorrect).length

  const failedNote = failedCount > 0 && (
    <div role="note" style={{
      background: 'var(--bg-card)',
      border: `1px solid ${tint('#f59e0b', 45)}`,
      borderLeft: '4px solid #f59e0b',
      borderRadius: '12px',
      padding: '12px 16px',
      marginBottom: '16px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      color: 'var(--text-primary)',
      fontSize: '14px'
    }}>
      <span aria-hidden="true" style={{ display: 'inline-flex', color: '#f59e0b' }}><TriangleAlert size={18} /></span>
      <span>
        {failedCount === 1
          ? "We couldn't prepare one of your follow-up questions — you'll see fewer than expected."
          : `We couldn't prepare ${failedCount} of your follow-up questions — you'll see fewer than expected.`}
      </span>
    </div>
  )

  // ---------- Answering: same look as the live question card on the student room page ----------
  if (!isReview) {
    return shell(
      <>
        {failedNote}
        <div style={{
          background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
          borderRadius: 'var(--radius-lg)',
          padding: isMobile ? '20px 16px' : '32px',
          color: 'white',
          boxShadow: '0 10px 40px rgba(124, 58, 237, 0.3)',
          maxWidth: '100%',
          boxSizing: 'border-box'
        }}>
          {/* Timer */}
          <div style={{ textAlign: 'center', marginBottom: '24px' }}>
            <div style={{
              width: '100px',
              height: '100px',
              borderRadius: '50%',
              border: '4px solid rgba(255,255,255,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px'
            }}>
              <span style={{ fontSize: '36px', fontWeight: '700', color: timeLeft <= 5 ? '#ffd700' : 'white' }}>{timeLeft}</span>
            </div>
            <p style={{ fontSize: '14px', opacity: 0.9, margin: 0 }}>seconds remaining</p>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <span style={{
              padding: '4px 12px',
              borderRadius: '999px',
              background: 'rgba(255,255,255,0.18)',
              border: '1px solid rgba(255,255,255,0.28)',
              fontSize: '12px',
              fontWeight: 700
            }}>
              Follow-up question {currentIndex + 1} of {questions.length}
            </span>
            <span style={{ fontSize: '12px', opacity: 0.85 }}>practice · doesn't affect your score</span>
          </div>

          {/* Question */}
          <h2 style={{ fontSize: isMobile ? '20px' : '24px', fontWeight: '700', textAlign: 'center', margin: `0 0 ${isMobile ? '24px' : '32px'}`, wordBreak: 'break-word' }}>
            {decodeHtml(question?.question)}
          </h2>

          {/* Options */}
          <div style={{ display: 'grid', gap: '12px', marginBottom: '24px' }}>
            {question?.options?.map((opt, idx) => {
              const isSelected = selectedOption === idx
              return (
                <button
                  key={idx}
                  onClick={() => !isSubmitting && setSelectedOption(idx)}
                  disabled={isSubmitting}
                  style={{
                    width: '100%',
                    minHeight: '48px',
                    boxSizing: 'border-box',
                    padding: isMobile ? '14px 16px' : '20px 24px',
                    background: isSelected ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)',
                    border: `2px solid ${isSelected ? '#ffd700' : 'rgba(255,255,255,0.2)'}`,
                    borderRadius: '12px',
                    color: 'white',
                    fontSize: isMobile ? '16px' : '18px',
                    textAlign: 'left',
                    cursor: isSubmitting ? 'default' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: isMobile ? '12px' : '16px'
                  }}
                >
                  <span style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '50%',
                    background: isSelected ? '#ffd700' : 'rgba(255,255,255,0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: '700',
                    color: isSelected ? '#1f2937' : 'white',
                    fontSize: '16px',
                    flexShrink: 0
                  }}>
                    {String.fromCharCode(65 + idx)}
                  </span>
                  <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{decodeHtml(opt.text)}</span>
                </button>
              )
            })}
          </div>

          <button
            onClick={() => selectedOption !== null && handleSubmit(selectedOption)}
            disabled={selectedOption === null || isSubmitting}
            style={{
              width: '100%',
              padding: '16px',
              background: selectedOption !== null ? '#ffd700' : 'rgba(255,255,255,0.2)',
              color: selectedOption !== null ? '#1f2937' : 'rgba(255,255,255,0.5)',
              border: 'none',
              borderRadius: '12px',
              fontSize: '16px',
              fontWeight: '600',
              cursor: selectedOption !== null && !isSubmitting ? 'pointer' : 'not-allowed'
            }}
          >
            {isSubmitting
              ? 'Submitting...'
              : currentIndex === questions.length - 1 ? 'Submit Final Answer' : 'Submit & Continue'}
          </button>
          <p style={{ margin: '14px 0 0', textAlign: 'center', fontSize: '13px', opacity: 0.85 }}>
            Answers and explanations appear after the last question.
          </p>
        </div>
      </>,
      `Question ${currentIndex + 1} of ${questions.length} · explanations come after the last one`
    )
  }

  // ---------- Review: every question with the correct answer + explanation, same page ----------
  return shell(
    <>
      {failedNote}
      <TileGrid isMobile={isMobile} cols={1}>
        <StatTile
          icon={CircleCheck}
          label="Follow-up questions correct"
          value={`${correctCount} / ${questions.length}`}
          sub="practice only — these don't count toward your score or rank"
          tint="#059669"
          progress={questions.length ? (correctCount / questions.length) * 100 : undefined}
        />
      </TileGrid>

      {questions.map((q, qi) => {
        const a = answers.find(x => x.questionIndex === qi)
        const hasResult = a && !a.error
        return (
          <div key={q._id || qi} className="insight-card" style={cardStyle(isMobile)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
              <Pill tone="var(--accent)">Follow-up Q{qi + 1}</Pill>
              {hasResult && (
                <Pill tone={a.isCorrect ? '#059669' : '#dc2626'}>
                  {a.isCorrect ? <><Ico as={Check} /> Correct</> : <><Ico as={X} /> Not quite</>}
                </Pill>
              )}
            </div>

            <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 14px', lineHeight: 1.5 }}>
              {decodeHtml(q.question)}
            </p>

            <div style={{ display: 'grid', gap: '8px' }}>
              {q.options?.map((opt, idx) => {
                const isSelected = a?.selectedIdx === idx
                const isCorrectOpt = hasResult && a.correctOption === idx
                const isWrongSelected = hasResult && isSelected && !a.isCorrect
                const accent = isCorrectOpt ? '#059669' : isWrongSelected ? '#dc2626' : null

                return (
                  <div key={idx} style={{
                    padding: '10px 14px',
                    background: accent ? tint(accent, 12) : isSelected ? tint('var(--accent)', 12) : 'var(--bg-primary)',
                    borderRadius: 'var(--radius-sm)',
                    border: accent ? `2px solid ${accent}` : isSelected ? '2px solid var(--accent)' : '1px solid var(--border-color)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    minWidth: 0
                  }}>
                    <span style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '50%',
                      background: accent || 'var(--border-color)',
                      color: accent ? 'white' : 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '11px',
                      fontWeight: 700,
                      flexShrink: 0
                    }}>
                      {String.fromCharCode(65 + idx)}
                    </span>
                    <span style={{
                      fontSize: '14px',
                      color: 'var(--text-primary)',
                      fontWeight: isCorrectOpt ? 600 : 400,
                      minWidth: 0,
                      wordBreak: 'break-word'
                    }}>
                      {decodeHtml(opt.text)}
                    </span>
                    {isSelected && (
                      <span style={{
                        marginLeft: 'auto',
                        color: isWrongSelected ? tone('#dc2626') : isCorrectOpt ? tone('#059669') : 'var(--accent)',
                        fontSize: '13px',
                        fontWeight: 600,
                        flexShrink: 0,
                        whiteSpace: 'nowrap'
                      }}>
                        {a?.timedOut ? 'Time ran out' : 'Your answer'}
                      </span>
                    )}
                    {isCorrectOpt && !isSelected && (
                      <span style={{ marginLeft: 'auto', color: tone('#059669'), fontSize: '13px', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap' }}>
                        Correct answer
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            {hasResult && a.explanation && (
              <div style={{
                marginTop: '14px',
                padding: '12px 14px',
                borderRadius: '12px',
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderLeft: '4px solid var(--accent)'
              }}>
                <div style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Explanation
                </div>
                <div style={{ fontSize: '14px', lineHeight: 1.5, color: 'var(--text-primary)' }}>
                  {decodeHtml(a.explanation)}
                </div>
              </div>
            )}

            {!hasResult && (
              <p style={{ margin: '14px 0 0', color: tone('#dc2626'), fontSize: '13px' }}>
                {a?.error || 'No answer was recorded for this question.'}
              </p>
            )}
          </div>
        )
      })}

      <button onClick={goToResults} style={primaryButton(false, { width: '100%', padding: '14px 20px', fontSize: '15px' })}>
        <Ico as={ChartColumn} /> See results
      </button>
    </>,
    `${correctCount} of ${questions.length} correct · practice only`
  )
}

export default RemediationPage