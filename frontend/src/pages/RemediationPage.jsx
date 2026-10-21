import React, { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import useAuthStore from '../stores/authStore'
import { API_URL } from '../config.js'

// Decode HTML entities from LLM output
const decodeHtml = (text) => {
  if (!text) return ''
  const doc = new DOMParser().parseFromString(text, 'text/html')
  return doc.documentElement.textContent
}

const badgeStyle = {
  display: 'inline-block',
  padding: '3px 10px',
  background: 'rgba(99, 102, 241, 0.15)',
  border: '1px solid rgba(99, 102, 241, 0.4)',
  borderRadius: '12px',
  color: '#a5b4fc',
  fontSize: '11px',
  fontWeight: '700',
  letterSpacing: '0.02em',
  textTransform: 'uppercase'
}

const letterStyle = (background) => ({
  width: '28px',
  height: '28px',
  borderRadius: '50%',
  background,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '12px',
  fontWeight: '700',
  flexShrink: 0,
  color: 'white'
})

function RemediationPage() {
  const { roomId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const maxQuestions = parseInt(searchParams.get('max') ?? '2')
  const { user, token } = useAuthStore()

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
    const selectedIdx = timedOut ? 0 : optionIdx

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
          responseTime
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

  if (isLoading) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'var(--bg-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: '16px'
      }}>
        <div style={{
          width: '48px', height: '48px',
          border: '4px solid var(--border-color)',
          borderTopColor: '#f59e0b',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite'
        }} />
        <p style={{ color: 'var(--text-secondary)', fontSize: '16px' }}>
          Preparing your personalised questions...
        </p>
        <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: '#ef4444' }}>{error}</p>
          <button onClick={() => navigate(`/student/room/${roomId}/results`)} style={{
            marginTop: '16px', padding: '10px 24px', background: '#3b82f6',
            color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer'
          }}>
            Go to Results
          </button>
        </div>
      </div>
    )
  }

  const question = questions[currentIndex]
  const tta = question?.timeToAnswer || 30
  const timerPct = (timeLeft / tta) * 100
  const timerColor = timeLeft <= 5 ? '#ef4444' : timeLeft <= 10 ? '#f59e0b' : '#10b981'
  const isReview = phase === 'review'
  const totalPoints = answers.reduce((sum, a) => sum + (a.points || 0), 0)
  const correctCount = answers.filter(a => a.isCorrect).length

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: isReview ? 'flex-start' : 'center',
      padding: '24px',
      fontFamily: 'system-ui, sans-serif'
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 16px',
          background: 'rgba(245, 158, 11, 0.2)',
          border: '1px solid rgba(245, 158, 11, 0.4)',
          borderRadius: '20px',
          marginBottom: '12px'
        }}>
          <span style={{ fontSize: '16px' }}>🔁</span>
          <span style={{ color: '#fbbf24', fontSize: '13px', fontWeight: '600' }}>
            {isReview ? 'Your follow-up answers' : `Let's revisit this — ${currentIndex + 1} of ${questions.length}`}
          </span>
        </div>
        <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '13px', margin: 0 }}>
          {isReview
            ? `${correctCount} of ${questions.length} correct · +${totalPoints} pts`
            : 'Answer all the questions — explanations come after the last one'}
        </p>
        {failedCount > 0 && (
          <p style={{ color: 'rgba(251, 191, 36, 0.8)', fontSize: '12px', margin: '6px 0 0 0' }}>
            {failedCount === 1
              ? "We couldn't prepare one of your follow-up questions — you'll see fewer than expected."
              : `We couldn't prepare ${failedCount} of your follow-up questions — you'll see fewer than expected.`}
          </p>
        )}
      </div>

      {/* Timer */}
      {!isReview && (
        <div style={{ width: '100%', maxWidth: '560px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '12px' }}>Time remaining</span>
            <span style={{ color: timerColor, fontWeight: '700', fontSize: '16px' }}>{timeLeft}s</span>
          </div>
          <div style={{ height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px' }}>
            <div style={{
              height: '100%',
              width: `${timerPct}%`,
              background: timerColor,
              borderRadius: '4px',
              transition: 'width 1s linear, background 0.3s'
            }} />
          </div>
        </div>
      )}

      {!isReview ? (
        /* Answering phase: no correct/incorrect feedback until every question is answered */
        <div style={{
          width: '100%',
          maxWidth: '560px',
          background: 'rgba(255,255,255,0.05)',
          backdropFilter: 'blur(10px)',
          borderRadius: '20px',
          padding: '28px',
          border: '1px solid rgba(255,255,255,0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <span style={badgeStyle}>Follow-up question</span>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '12px' }}>
              worth {question?.points ?? 50} pts
            </span>
          </div>

          <p style={{
            color: 'white',
            fontSize: '18px',
            fontWeight: '600',
            lineHeight: '1.5',
            margin: '0 0 24px 0'
          }}>
            {decodeHtml(question?.question)}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {question?.options?.map((opt, idx) => {
              const letter = String.fromCharCode(65 + idx)
              const isSelected = selectedOption === idx
              return (
                <button
                  key={idx}
                  onClick={() => !isSubmitting && setSelectedOption(idx)}
                  disabled={isSubmitting}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '14px 16px',
                    background: isSelected ? 'rgba(99, 102, 241, 0.3)' : 'rgba(255,255,255,0.05)',
                    border: isSelected ? '2px solid #6366f1' : '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '12px',
                    color: 'rgba(255,255,255,0.9)',
                    fontSize: '15px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    width: '100%'
                  }}
                >
                  <span style={letterStyle('rgba(255,255,255,0.1)')}>{letter}</span>
                  {decodeHtml(opt.text)}
                </button>
              )
            })}
          </div>

          <button
            onClick={() => selectedOption !== null && handleSubmit(selectedOption)}
            disabled={selectedOption === null || isSubmitting}
            style={{
              marginTop: '20px',
              width: '100%',
              padding: '14px',
              borderRadius: '12px',
              border: 'none',
              background: selectedOption !== null ? 'linear-gradient(135deg, #6366f1, #4f46e5)' : 'rgba(255,255,255,0.1)',
              color: selectedOption !== null ? 'white' : 'rgba(255,255,255,0.3)',
              fontSize: '15px',
              fontWeight: '600',
              cursor: selectedOption !== null ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s'
            }}
          >
            {isSubmitting
              ? 'Submitting...'
              : currentIndex === questions.length - 1 ? 'Submit Final Answer' : 'Submit & Continue'}
          </button>
        </div>
      ) : (
        /* Review phase: every question with the correct answer + explanation, on this same page */
        <div style={{ width: '100%', maxWidth: '560px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {questions.map((q, qi) => {
            const a = answers.find(x => x.questionIndex === qi)
            const hasResult = a && !a.error
            return (
              <div key={q._id || qi} style={{
                background: 'rgba(255,255,255,0.05)',
                backdropFilter: 'blur(10px)',
                borderRadius: '20px',
                padding: '24px',
                border: '1px solid rgba(255,255,255,0.1)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <span style={badgeStyle}>Question {qi + 1}</span>
                  {hasResult && (
                    <span style={{ color: a.isCorrect ? '#6ee7b7' : '#fca5a5', fontSize: '12px', fontWeight: '600' }}>
                      {a.isCorrect ? `✓ Correct +${a.points} pts` : '✗ Not quite'}
                    </span>
                  )}
                </div>

                <p style={{ color: 'white', fontSize: '17px', fontWeight: '600', lineHeight: '1.5', margin: '0 0 16px 0' }}>
                  {decodeHtml(q.question)}
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {q.options?.map((opt, idx) => {
                    const letter = String.fromCharCode(65 + idx)
                    const isSelected = a?.selectedIdx === idx
                    const isCorrectOpt = hasResult && a.correctOption === idx
                    const isWrongSelected = hasResult && isSelected && !a.isCorrect

                    let bg = 'rgba(255,255,255,0.05)'
                    let border = '1px solid rgba(255,255,255,0.1)'
                    let color = 'rgba(255,255,255,0.9)'
                    if (isCorrectOpt) {
                      bg = 'rgba(16, 185, 129, 0.2)'; border = '2px solid #10b981'; color = '#6ee7b7'
                    } else if (isWrongSelected) {
                      bg = 'rgba(239, 68, 68, 0.2)'; border = '2px solid #ef4444'; color = '#fca5a5'
                    } else if (isSelected) {
                      bg = 'rgba(99, 102, 241, 0.3)'; border = '2px solid #6366f1'
                    }

                    return (
                      <div key={idx} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '12px 14px',
                        background: bg,
                        border,
                        borderRadius: '12px',
                        color,
                        fontSize: '14px'
                      }}>
                        <span style={letterStyle(isCorrectOpt ? '#10b981' : isWrongSelected ? '#ef4444' : 'rgba(255,255,255,0.1)')}>
                          {isCorrectOpt ? '✓' : isWrongSelected ? '✗' : letter}
                        </span>
                        <span style={{ flex: 1 }}>{decodeHtml(opt.text)}</span>
                        {isSelected && (
                          <span style={{ fontSize: '11px', opacity: 0.7, flexShrink: 0 }}>
                            {a?.timedOut ? 'time ran out' : 'your answer'}
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
                    background: a.isCorrect ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    border: `1px solid ${a.isCorrect ? '#10b981' : '#ef4444'}`
                  }}>
                    <p style={{ margin: '0 0 4px 0', color: 'rgba(255,255,255,0.9)', fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                      Explanation
                    </p>
                    <p style={{ margin: 0, color: 'rgba(255,255,255,0.75)', fontSize: '13px', lineHeight: '1.5' }}>
                      {decodeHtml(a.explanation)}
                    </p>
                  </div>
                )}

                {!hasResult && (
                  <p style={{ margin: '14px 0 0 0', color: '#fca5a5', fontSize: '13px' }}>
                    {a?.error || 'No answer was recorded for this question.'}
                  </p>
                )}
              </div>
            )
          })}

          <button
            onClick={goToResults}
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: '12px',
              border: 'none',
              background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
              color: 'white',
              fontSize: '15px',
              fontWeight: '600',
              cursor: 'pointer',
              marginBottom: '24px'
            }}
          >
            📊 See Results
          </button>
        </div>
      )}
    </div>
  )
}

export default RemediationPage