import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import useAuthStore from '../stores/authStore'
import useRoomStore from '../stores/roomStore'
import useSocketStore from '../stores/socketStore'
import Sidebar from '../components/Sidebar'
import { PageHeader, Pill } from '../components/AppUI'
import { SectionHeader, cardStyle } from '../components/InsightUI'
import { API_URL } from '../config.js'
import { fetchAllRoomQuestions } from '../services/questionService'
import useIsMobile from '../hooks/useIsMobile'
import RoomInsights from '../components/RoomInsights'
import StudentInsights from '../components/StudentInsights'
import { downloadText, safeFilename } from '../lib/questionsExport'
import { ArrowLeft, Award, ChartColumn, Check, CircleCheck, FileText, Inbox, RotateCcw, Target, TriangleAlert, Users, X } from 'lucide-react'
import { Ico, renderIcon } from '../components/icons'

// Theme-aware colour helpers (same recipe as InsightUI/AppUI): a translucent tint for backgrounds, and a
// tone lifted toward white in dark mode for text.
const tintBg = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`
const toneInk = (c) => `color-mix(in srgb, ${c}, white var(--tone-lift))`

function RoomResultsPage() {
  const { roomId } = useParams()
  const navigate = useNavigate()
  const { user, token } = useAuthStore()
  const { setAuthToken } = useRoomStore()
  const { socket, joinRoom, leaveRoom } = useSocketStore()
  const isMobile = useIsMobile()

  const [room, setRoom] = useState(null)
  const [questions, setQuestions] = useState([])
  const [responses, setResponses] = useState({})
  const [isLoading, setIsLoading] = useState(true)
  const [insights, setInsights] = useState(null)   // GET /responses/insights/:roomId (teacher: full, student: own results vs class)
  const [insightsFailed, setInsightsFailed] = useState(false) // → show the plain summary cards + question list instead
  const [stats, setStats] = useState({
    totalResponses: 0,
    totalCorrect: 0,
    averageScore: 0,
    participationRate: 0
  })

  useEffect(() => {
    if (token) {
      setAuthToken(token)
      fetchRoomData()
    }
  }, [token, roomId])

  // Join the room's socket channel and listen for remediation submissions, so a teacher sitting
  // on this page sees new remediation answers come in live instead of needing to refresh.
  // RoomDetailPage already leaves this channel when the room is ended, so this page has to
  // (re)join it for itself. Students don't need this — their own answer already updates their
  // view instantly via local state, and other students' answers don't affect what they see.
  useEffect(() => {
    if (user?.role !== 'teacher' || !room?.code || !user?._id || !socket) return

    joinRoom(room.code, user._id)

    const handleRemediationSubmitted = () => {
      fetchRoomData()
    }
    socket.on('remediation:submitted', handleRemediationSubmitted)

    return () => {
      socket.off('remediation:submitted', handleRemediationSubmitted)
      leaveRoom(room.code, user._id)
    }
  }, [room?.code, user?._id, user?.role, socket])

  const fetchRoomData = async () => {
    setIsLoading(true)
    try {
      // Fetch room details
      const roomRes = await fetch(`${API_URL}/rooms/${roomId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const roomData = await roomRes.json()
      if (roomRes.ok) {
        setRoom(roomData.room || roomData)
      }

      // Session insights (one aggregated payload). Non-fatal: if it fails, the page falls back to the
      // plain summary cards and question list.
      setInsights(null)
      setInsightsFailed(false)
      fetch(`${API_URL}/responses/insights/${roomId}`, { headers: { 'Authorization': `Bearer ${token}` } })
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (d?.success) setInsights(d); else setInsightsFailed(true) })
        .catch(() => setInsightsFailed(true))

      if (user?.role === 'student') {
        // Student: fetch their own responses (includes questions with answers)
        const studentRes = await fetch(`${API_URL}/responses/room/${roomId}/student/${user._id}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        const studentData = await studentRes.json()

        // Use studentData.questions for rendering (has answered, isCorrect, pointsEarned, etc.)
        setQuestions(studentData.questions || [])

        // Build responses data from student's question data. Remediation Q&A is still stored here
        // (so the remediation section below can render it) but is excluded from the headline
        // stats — it's extra practice worth different points, not part of the quiz score.
        const responsesData = {}
        let totalResponses = 0
        let totalCorrect = 0
        let totalPoints = 0

        studentData.questions?.forEach(q => {
          if (q.answered) {
            responsesData[q._id] = {
              totalResponses: 1,
              correctCount: q.isCorrect ? 1 : 0,
              points: q.pointsEarned || 0
            }
            if (!q.isRemediation) {
              totalResponses += 1
              if (q.isCorrect) totalCorrect += 1
              totalPoints += q.pointsEarned || 0
            }
          }
        })

        setResponses(responsesData)

        // Fetch leaderboard to get student's rank
        const leaderboardRes = await fetch(`${API_URL}/responses/leaderboard/${roomId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        const leaderboardData = await leaderboardRes.json()
        const userRank = leaderboardData.userRank || 0

        const averageScore = totalResponses > 0 ? Math.round((totalPoints / (totalResponses * 100)) * 100) : 0

        setStats({
          totalResponses,
          totalCorrect,
          averageScore,
          participationRate: 100,
          userRank,
          totalPoints
        })
      } else {
        // Teacher: fetch ALL questions (pages past the API's 50/page cap) so results show the true
        // question count and every question's stats. Students don't need this — their per-response
        // call above already returns the questions with their answers merged in.
        const roomQuestions = await fetchAllRoomQuestions(roomId)
        setQuestions(roomQuestions)

        // Teacher: fetch full room stats once
        const rRes = await fetch(`${API_URL}/responses/stats/room/${roomId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        const rData = await rRes.json()

        // Build responsesData from questionStats
        const responsesData = {}
        const questionStats = rData.stats?.questionStats || []

        questionStats.forEach(qStat => {
          responsesData[qStat.questionId] = {
            totalResponses: qStat.totalResponses,
            correctCount: qStat.correctCount || 0,
            answerCounts: qStat.answerCounts || {}
          }
        })

        setResponses(responsesData)

        // Calculate overall stats from aggregated data
        const totalResponses = rData.stats?.totalResponses || 0
        const totalCorrect = questionStats.filter(q => !q.isRemediation).reduce((sum, q) => sum + (q.correctCount || 0), 0)
        const averageScore = totalResponses > 0 ? Math.round((totalCorrect / totalResponses) * 100) : 0
        const uniqueStudents = rData.stats?.totalStudents || 0
        const participationRate = roomQuestions.length > 0
          ? Math.round((uniqueStudents / Math.max(roomQuestions.length, 1)) * 100)
          : 0

        setStats({
          totalResponses,
          totalCorrect,
          averageScore,
          // "Total Students" card = the room roster (joined); fall back to responders if the
          // backend didn't supply it.
          totalStudents: rData.stats?.totalJoined ?? uniqueStudents,
          participationRate: Math.min(participationRate, 100)
        })
      }
    } catch (err) {
      console.error('Failed to fetch room results:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const exportResponsesCsv = async () => {
    try {
      const res = await fetch(`${API_URL}/responses/room/${roomId}/export`, { headers: { 'Authorization': `Bearer ${token}` } })
      if (!res.ok) throw new Error('Export failed')
      downloadText(safeFilename(`${room?.name || 'room'}_${room?.code || ''}_responses`) + '.csv', await res.text(), 'text/csv')
    } catch (e) { window.alert('Could not download the responses CSV. Please try again.') }
  }

  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        minHeight: '100vh',
        maxWidth: '100%',
        boxSizing: 'border-box',
        background: 'var(--bg-primary)',
        fontFamily: '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif'
      }}>
        <Sidebar user={user} />
        <div style={{ flex: 1, minWidth: 0, marginLeft: 'var(--sidebar-width, 240px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: '48px',
              height: '48px',
              border: '4px solid var(--border-color)',
              borderTopColor: 'var(--accent)',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              margin: '0 auto 16px'
            }} />
            <p style={{ color: 'var(--text-secondary)' }}>Loading results...</p>
          </div>
        </div>
      </div>
    )
  }
  // Remediation questions are personalized, generated after the fact, and worth different points
  // than the quiz itself — split them into their own reviewable section instead of the main list.
  const mainQuestions = questions.filter(q => !q.isRemediation)
  const remediationQuestions = questions.filter(q => q.isRemediation)

  // Fallback summary cards — only shown if the insights call failed. Normally each role's single tile
  // row lives in RoomInsights / StudentInsights (one source of numbers, no duplicates).
  const statCards = [
    { icon: FileText, value: mainQuestions.length, label: 'Total Questions', tint: 'var(--accent)' },
    { icon: Users, value: stats.totalResponses, label: 'Total Responses', tint: 'var(--accent)' },
    ...(user?.role === 'teacher'
      ? [{ icon: Users, value: stats.totalStudents || 0, label: 'Total Students', tint: 'var(--accent)' }]
      : [{ icon: Award, value: stats.userRank ? `#${stats.userRank}` : '—', label: 'Your Rank', tint: '#f59e0b', valueColor: '#f59e0b' }]),
    { icon: CircleCheck, value: `${stats.averageScore}%`, label: 'Average Score', tint: '#059669', valueColor: '#059669' },
    { icon: Target, value: stats.totalCorrect, label: 'Correct Answers', tint: 'var(--accent)', valueColor: 'var(--accent)' },
  ]

  return (
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
        <PageHeader isMobile={isMobile} icon={ChartColumn} eyebrow="Session results" title={room?.name || 'Room'}
          subtitle={<>Code <strong style={{ letterSpacing: '0.1em' }}>{room?.code}</strong> · Completed{room?.endedAt ? ` · ${new Date(room.endedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</>} />

        {/* Content (faint accent wash behind the results) */}
        <div style={{
          flex: 1,
          background: 'radial-gradient(900px 360px at 0% 0%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 70%), radial-gradient(700px 300px at 100% 0%, color-mix(in srgb, #8b5cf6 6%, transparent), transparent 70%)',
          padding: isMobile ? '16px' : '32px',
          maxWidth: '100%',
          boxSizing: 'border-box'
        }}>
          {/* Back Button */}
          <button
            onClick={() => navigate(`/${user?.role === 'teacher' ? 'teacher' : 'student'}/room-history`)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 14px',
              background: 'var(--bg-card)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: 'var(--shadow-sm)',
              marginBottom: '24px'
            }}
          >
            <Ico as={ArrowLeft} /> Back
          </button>

          {/* Fallback overview stats (insights unavailable) */}
          {insightsFailed && (
          <div data-tour="results-stats" style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '16px',
            marginBottom: '24px'
          }}>
            {statCards.map((card, i) => (
              <div key={i} style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-md)',
                padding: '20px',
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
              }}>
                <div style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '20px',
                  background: 'color-mix(in srgb, ' + card.tint + ' 14%, transparent)',
                  border: '1px solid color-mix(in srgb, ' + card.tint + ' 22%, transparent)',
                  color: 'color-mix(in srgb, ' + card.tint + ', white var(--tone-lift))'
                }} aria-hidden="true">
                  {renderIcon(card.icon, 20)}
                </div>
                <div style={{
                  fontSize: isMobile ? '26px' : '30px',
                  fontWeight: 700,
                  letterSpacing: '-0.02em',
                  lineHeight: 1.1,
                  color: card.valueColor || 'var(--text-primary)'
                }}>
                  {card.value}
                </div>
                <div style={{ fontSize: '12.5px', fontWeight: 500, color: 'var(--text-secondary)' }}>
                  {card.label}
                </div>
              </div>
            ))}
          </div>
          )}

          {/* Session insights — teachers get the class analytics (and the collapsible item analysis replaces the
              old question list below); students get THEIR OWN results against the class, then their answer list. */}
          {insights && user?.role === 'teacher' && (
            <RoomInsights insights={insights} isTeacher isMobile={isMobile} onExportResponses={exportResponsesCsv} />
          )}
          {insights && user?.role !== 'teacher' && (
            <StudentInsights insights={insights} isMobile={isMobile} />
          )}

          {/* Fallback question list — only if the insights call failed; both roles otherwise get the
              collapsible question-wise analysis above (teacher: item analysis, student: own results). */}
          {insightsFailed && (
          <div data-tour="question-analysis" style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-md)',
            padding: isMobile ? '18px' : '24px',
            maxWidth: '100%',
            boxSizing: 'border-box'
          }}>
            <h2 style={{
              margin: '0 0 20px',
              fontSize: '18px',
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: 'var(--text-primary)'
            }}>
              Question-wise Analysis
            </h2>

            {mainQuestions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-secondary)' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px', color: 'var(--text-secondary)' }}><Inbox size={48} strokeWidth={1.5} aria-hidden="true" /></div>
                <p style={{ margin: 0 }}>No questions were asked in this room.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {mainQuestions.map((q, index) => {
                  const qStats = responses[q._id] || {}
                  const isTeacher = user?.role === 'teacher'

                  // Teacher: show class percentage. Student: show their result
                  const correctRate = isTeacher && qStats.totalResponses > 0
                    ? Math.round((qStats.correctCount / qStats.totalResponses) * 100)
                    : q.answered ? (q.isCorrect ? 100 : 0) : null

                  // Score card accent (semantic) — mirrors the original thresholds/answer logic.
                  const scoreColor = isTeacher
                    ? (correctRate >= 70 ? '#059669' : correctRate >= 40 ? '#d97706' : '#dc2626')
                    : (q.answered ? (q.isCorrect ? '#059669' : '#dc2626') : '#d97706')

                  return (
                    <div key={q._id} style={{
                      padding: isMobile ? '16px' : '20px',
                      background: 'var(--bg-primary)',
                      borderRadius: 'var(--radius)',
                      border: '1px solid var(--border-color)',
                      minWidth: 0
                    }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: '16px',
                        flexDirection: isMobile ? 'column' : 'row'
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                            <span style={{
                              width: '28px',
                              height: '28px',
                              borderRadius: '50%',
                              background: 'var(--accent-solid)',
                              color: 'white',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '12px',
                              fontWeight: 700,
                              flexShrink: 0
                            }}>
                              {index + 1}
                            </span>
                            <span style={{
                              padding: '3px 8px',
                              background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                              color: 'var(--accent)',
                              borderRadius: '6px',
                              fontSize: '11px',
                              fontWeight: 600
                            }}>
                              {q.type}
                            </span>
                            <span style={{
                              padding: '3px 8px',
                              background: 'color-mix(in srgb, #d97706 16%, transparent)',
                              color: '#b45309',
                              borderRadius: '6px',
                              fontSize: '11px',
                              fontWeight: 600
                            }}>
                              {q.maxPoints || q.points} pts
                            </span>
                            {q.answered && (
                              <span style={{
                                padding: '3px 8px',
                                borderRadius: '6px',
                                fontSize: '11px',
                                fontWeight: 600,
                                background: q.isCorrect ? 'color-mix(in srgb, #059669 16%, transparent)' : 'color-mix(in srgb, #dc2626 16%, transparent)',
                                color: q.isCorrect ? '#059669' : '#dc2626'
                              }}>
                                {q.isCorrect ? <><Ico as={Check} /> Correct</> : <><Ico as={X} /> Incorrect</>}
                              </span>
                            )}
                          </div>
                          <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 14px', lineHeight: 1.5 }}>
                            {q.question}
                          </p>

                          {/* Options - show differently for teacher vs student */}
                          <div style={{ display: 'grid', gap: '8px' }}>
                            {q.options && q.options.map((opt, optIdx) => {
                              const isCorrect = opt.isCorrect
                              const isSelected = q.selectedOption === optIdx

                              // For student: highlight their selection. For teacher: highlight correct answer
                              const showAsSelected = isTeacher ? isCorrect : isSelected
                              const highlightStyle = showAsSelected
                                ? (isTeacher ? 'color-mix(in srgb, #059669 12%, transparent)' : (isSelected ? (isCorrect ? 'color-mix(in srgb, #059669 12%, transparent)' : 'color-mix(in srgb, #dc2626 12%, transparent)') : 'color-mix(in srgb, #059669 12%, transparent)'))
                                : 'var(--bg-card)'
                              const borderStyle = showAsSelected
                                ? (isTeacher ? '2px solid #059669' : (isSelected ? '2px solid var(--accent)' : '2px solid #059669'))
                                : '1px solid var(--border-color)'

                              return (
                                <div key={optIdx} style={{
                                  padding: '10px 14px',
                                  background: highlightStyle,
                                  borderRadius: 'var(--radius-sm)',
                                  border: borderStyle,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '12px',
                                  minWidth: 0
                                }}>
                                  <span style={{
                                    width: '24px',
                                    height: '24px',
                                    borderRadius: '50%',
                                    background: isCorrect ? '#059669' : 'var(--border-color)',
                                    color: isCorrect ? 'white' : 'var(--text-secondary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '11px',
                                    fontWeight: 700,
                                    flexShrink: 0
                                  }}>
                                    {String.fromCharCode(65 + optIdx)}
                                  </span>
                                  <span style={{
                                    fontSize: '14px',
                                    color: 'var(--text-primary)',
                                    fontWeight: isCorrect ? 600 : 400,
                                    minWidth: 0
                                  }}>
                                    {opt.text}
                                  </span>
                                  {isTeacher && isCorrect && (
                                    <span style={{ marginLeft: 'auto', color: '#059669', fontSize: '14px', flexShrink: 0, display: 'inline-flex' }}><Check size={16} strokeWidth={2.75} aria-label="Correct" /></span>
                                  )}
                                  {!isTeacher && isSelected && (
                                    <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: '13px', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap' }}>Your answer</span>
                                  )}
                                  {!isTeacher && isCorrect && !isSelected && (
                                    <span style={{ marginLeft: 'auto', color: '#059669', fontSize: '13px', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap' }}>Correct answer</span>
                                  )}
                                </div>
                              )
                            })}
                          </div>

                          {/* Teacher: visual distribution bar of class correctness (purely presentational) */}
                          {isTeacher && (
                            <div style={{ marginTop: '14px' }}>
                              <div style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                fontSize: '11px',
                                color: 'var(--text-secondary)',
                                marginBottom: '6px',
                                fontWeight: 600
                              }}>
                                <span>Class correct rate</span>
                                <span>{correctRate !== null ? `${correctRate}%` : '0%'}</span>
                              </div>
                              <div style={{
                                height: '8px',
                                borderRadius: '999px',
                                background: 'var(--border-color)',
                                overflow: 'hidden'
                              }}>
                                <div style={{
                                  height: '100%',
                                  width: `${Math.max(0, Math.min(100, correctRate || 0))}%`,
                                  background: scoreColor,
                                  borderRadius: '999px',
                                  transition: 'width 0.3s ease'
                                }} />
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Question Stats */}
                        <div style={{
                          minWidth: isMobile ? 0 : '120px',
                          width: isMobile ? '100%' : 'auto',
                          textAlign: 'center',
                          padding: '16px',
                          background: 'color-mix(in srgb, ' + scoreColor + ' 12%, transparent)',
                          border: '1px solid color-mix(in srgb, ' + scoreColor + ' 24%, transparent)',
                          borderRadius: 'var(--radius)',
                          flexShrink: 0
                        }}>
                          {isTeacher ? (
                            <>
                              <div style={{ fontSize: isMobile ? '28px' : '32px', fontWeight: 700, letterSpacing: '-0.02em', color: scoreColor }}>
                                {correctRate !== null ? `${correctRate}%` : '0%'}
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', fontWeight: 500 }}>
                                {qStats.totalResponses || 0} responses
                              </div>
                            </>
                          ) : (
                            <>
                              <div style={{ fontSize: isMobile ? '28px' : '32px', fontWeight: 700, letterSpacing: '-0.02em', color: scoreColor }}>
                                {q.pointsEarned || 0}
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', fontWeight: 500 }}>
                                / {q.maxPoints || 100} pts
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          )}

          {/* Follow-up (remediation) questions — shown separately from the main quiz: personalized per
              student, generated after the session, and worth different points, so mixing them into the
              numbered list would misrepresent the quiz the teacher built. Same card language as the
              rest of the results page (InsightUI cards, pills, theme tokens). */}
          {remediationQuestions.length > 0 && (
            <div className="insight-card" style={{ ...cardStyle(isMobile), marginTop: '24px' }}>
              <SectionHeader
                icon={RotateCcw}
                tint="#8b5cf6"
                title="Follow-up questions"
                hint={user?.role === 'teacher'
                  ? 'Practice questions generated for students who missed one of the quiz questions above. They don\'t count toward points, rank or class statistics.'
                  : 'Extra practice questions based on what you missed above. They don\'t count toward your points or rank.'}
              />

              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {remediationQuestions.map((q, index) => {
                  const qStats = responses[q._id] || {}
                  const isTeacher = user?.role === 'teacher'

                  const correctRate = isTeacher && qStats.totalResponses > 0
                    ? Math.round((qStats.correctCount / qStats.totalResponses) * 100)
                    : q.answered ? (q.isCorrect ? 100 : 0) : null

                  const scoreColor = isTeacher
                    ? (correctRate >= 70 ? '#059669' : correctRate >= 40 ? '#d97706' : '#dc2626')
                    : (q.answered ? (q.isCorrect ? '#059669' : '#dc2626') : '#d97706')

                  return (
                    <div key={q._id} style={{
                      padding: isMobile ? '16px' : '20px',
                      background: 'var(--bg-primary)',
                      borderRadius: 'var(--radius)',
                      border: '1px solid var(--border-color)',
                      minWidth: 0
                    }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: '16px',
                        flexDirection: isMobile ? 'column' : 'row'
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                            <Pill tone="#8b5cf6">Follow-up Q{index + 1} · practice</Pill>
                            {!isTeacher && q.answered && (
                              <Pill tone={q.isCorrect ? '#059669' : '#dc2626'}>
                                {q.isCorrect ? <><Ico as={Check} /> Correct</> : <><Ico as={X} /> Incorrect</>}
                              </Pill>
                            )}
                          </div>
                          <p style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 14px', lineHeight: 1.45 }}>
                            {q.question}
                          </p>

                          <div style={{ display: 'grid', gap: '8px' }}>
                            {q.options && q.options.map((opt, optIdx) => {
                              // for follow-up questions, only reveal correct answer if student has answered
                              // (teachers always see the correct answer)
                              const showCorrectAnswer = isTeacher || q.answered
                              const isCorrect = showCorrectAnswer && opt.isCorrect
                              const isSelected = q.selectedOption === optIdx
                              const showAsSelected = isTeacher ? isCorrect : isSelected
                              const highlightStyle = showAsSelected
                                ? (isTeacher ? tintBg('#059669', 12) : (isSelected ? (isCorrect ? tintBg('#059669', 12) : tintBg('#dc2626', 12)) : tintBg('#059669', 12)))
                                : 'var(--bg-card)'
                              const borderStyle = showAsSelected
                                ? (isTeacher ? '2px solid #059669' : (isSelected ? '2px solid var(--accent)' : '2px solid #059669'))
                                : '1px solid var(--border-color)'

                              return (
                                <div key={optIdx} style={{
                                  padding: '10px 14px',
                                  background: highlightStyle,
                                  borderRadius: 'var(--radius-sm)',
                                  border: borderStyle,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '12px',
                                  minWidth: 0
                                }}>
                                  <span style={{
                                    width: '24px',
                                    height: '24px',
                                    borderRadius: '50%',
                                    background: isCorrect ? '#059669' : 'var(--border-color)',
                                    color: isCorrect ? 'white' : 'var(--text-secondary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '11px',
                                    fontWeight: 700,
                                    flexShrink: 0
                                  }}>
                                    {String.fromCharCode(65 + optIdx)}
                                  </span>
                                  <span style={{
                                    fontSize: '14px',
                                    color: 'var(--text-primary)',
                                    fontWeight: isCorrect ? 600 : 400,
                                    minWidth: 0
                                  }}>
                                    {opt.text}
                                  </span>
                                  {isTeacher && isCorrect && (
                                    <span style={{ marginLeft: 'auto', color: toneInk('#059669'), fontSize: '14px', flexShrink: 0, display: 'inline-flex' }}><Check size={16} strokeWidth={2.75} aria-label="Correct" /></span>
                                  )}
                                  {!isTeacher && isSelected && (
                                    <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: '13px', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap' }}>Your answer</span>
                                  )}
                                  {!isTeacher && isCorrect && !isSelected && (
                                    <span style={{ marginLeft: 'auto', color: toneInk('#059669'), fontSize: '13px', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap' }}>Correct answer</span>
                                  )}
                                </div>
                              )
                            })}
                          </div>

                          {!isTeacher && !q.answered && (
                            <div style={{
                              marginTop: '12px',
                              padding: '10px 14px',
                              background: tintBg('#f59e0b', 12),
                              border: `1px solid ${tintBg('#f59e0b', 30)}`,
                              borderRadius: 'var(--radius-sm)',
                              color: toneInk('#b45309'),
                              fontSize: '13px',
                              fontWeight: 600,
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px'
                            }}>
                              <TriangleAlert size={16} aria-hidden="true" /> You didn't complete this follow-up question
                            </div>
                          )}
                        </div>

                        <div style={{
                          minWidth: isMobile ? 0 : '120px',
                          width: isMobile ? '100%' : 'auto',
                          textAlign: 'center',
                          padding: '16px',
                          background: tintBg(scoreColor, 12),
                          border: `1px solid ${tintBg(scoreColor, 24)}`,
                          borderRadius: 'var(--radius)',
                          flexShrink: 0
                        }}>
                          {isTeacher ? (
                            <>
                              <div style={{ fontSize: isMobile ? '28px' : '32px', fontWeight: 700, letterSpacing: '-0.02em', color: toneInk(scoreColor) }}>
                                {correctRate !== null ? `${correctRate}%` : '—'}
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', fontWeight: 500 }}>
                                {qStats.totalResponses || 0} responses
                              </div>
                            </>
                          ) : (
                            <>
                              <div style={{ fontSize: isMobile ? '22px' : '24px', fontWeight: 700, letterSpacing: '-0.02em', color: toneInk(scoreColor) }}>
                                {q.answered ? (q.isCorrect ? 'Correct' : 'Missed') : '—'}
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', fontWeight: 500 }}>
                                practice
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default RoomResultsPage
