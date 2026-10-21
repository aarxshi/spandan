import express from 'express'
import { authenticate, authorize } from '../middleware/auth.js'
import { ensureRemediationQuestion } from '../services/questionService.js'
import * as resultsSnapshot from '../services/resultsSnapshot.js'

const router = express.Router()
router.use(authenticate)

// Many students submit / generate at once at room end, and each one used to drop the results
// snapshot, forcing constant rebuilds right when everyone loads results. Coalesce: at most one
// invalidation per room per window (the last answer in a burst is still picked up).
const invalidatePending = new Map()
function invalidateSoon(roomId, ms = 10000) {
  const key = String(roomId)
  if (invalidatePending.has(key)) return
  invalidatePending.set(key, setTimeout(() => {
    invalidatePending.delete(key)
    resultsSnapshot.invalidate(roomId).catch(() => {})
  }, ms))
}

// POST /api/remediation/generate
// Called when room ends — finds the hardest questions class-wide that this student got wrong,
// generates remediation questions (one per parent question, cached so multiple students share the same LLM call result)
// Authorization: student only
router.post('/generate', authorize('student'), async (req, res) => {
  try {
    const Question = (await import('../models/Question.js')).default
    const Response = (await import('../models/Response.js')).default
    const Room = (await import('../models/Room.js')).default
    const RoomMember = (await import('../models/RoomMember.js')).default

    const { roomId, maxQuestions: rawMaxQuestions = 2 } = req.body
    const studentId = req.user._id

    if (!roomId) return res.status(400).json({ error: 'roomId is required' })

    // Verify student is a member of this room
    const isMember = await RoomMember.findOne({ roomId, studentId })
    if (!isMember) return res.status(403).json({ error: 'Not a member of this room' })

    // Get room for provider setting
    const room = await Room.findById(roomId).lean()
    if (!room) return res.status(404).json({ error: 'Room not found' })
    // Follow-ups only exist after the room has ended. Before that, calling this would reveal whether
    // the student got a live question wrong (non-empty result) and could generate an explanation
    // that gives away the answer to a poll that is still running.
    if (!room.endedAt) {
      return res.status(409).json({ error: 'Room has not ended yet' })
    }
    const provider = room.settings?.questionProvider || 'minimax'

    // The room's own setting is the authority, not the client: maxQuestions comes straight from the
    // browser (and a student's copy of the room can be stale if the teacher changed the setting after
    // they joined). Take the smaller of the two and clamp to the 0-5 the settings dialog offers (each
    // question is an LLM call in the worst case). 0 = follow-ups are off for this room.
    const roomMax = Number.isFinite(room.settings?.maxFollowUpQuestions) ? room.settings.maxFollowUpQuestions : 2
    const maxQuestions = Math.max(0, Math.min(5, roomMax, Number(rawMaxQuestions) || 0))
    if (maxQuestions === 0) {
      return res.json({ success: true, questions: [], failedCount: 0, message: 'Follow-up questions are turned off for this room' })
    }

    // Step 1: get this student's wrong answers
    // Class questions only: a wrong follow-up answer is also isCorrect:false, and without this filter a
    // second visit to this endpoint would treat it as a "missed question" and generate a follow-up
    // to a follow-up.
    const wrongResponses = await Response.find({ roomId, studentId, isCorrect: false, isRemediation: { $ne: true } }).lean()
    if (wrongResponses.length === 0) {
      return res.json({ success: true, questions: [], message: 'No wrong answers — no remediation needed' })
    }

    // Step 2: get class-wide accuracy per question (one aggregation, no N+1)
    const mongoose = (await import('mongoose')).default
    const roomObjId = new mongoose.Types.ObjectId(roomId)

    const grouped = await Response.aggregate([
      { $match: { roomId: roomObjId } },
      {
        $group: {
          _id: '$questionId',
          totalResponses: { $sum: 1 },
          correctCount: { $sum: { $cond: ['$isCorrect', 1, 0] } }
        }
      }
    ])

    // Map questionId -> class accuracy (0 to 1)
    const accuracyMap = new Map()
    for (const g of grouped) {
      accuracyMap.set(String(g._id), g.totalResponses > 0 ? g.correctCount / g.totalResponses : 0)
    }

    // Step 3: sort student's wrong questions by class accuracy ascending (hardest first)
    // then take top maxQuestions
    const wrongQuestionIds = wrongResponses.map(r => String(r.questionId))
    const sortedWrongIds = wrongQuestionIds
      .sort((a, b) => (accuracyMap.get(a) || 0) - (accuracyMap.get(b) || 0))
      .slice(0, maxQuestions)

    // Step 4: fetch the parent questions
    const parentQuestions = await Question.find({ _id: { $in: sortedWrongIds } }).lean()
    const parentMap = new Map(parentQuestions.map(q => [String(q._id), q]))

    // Step 5: for each selected question, get-or-generate its remediation question.
    // ensureRemediationQuestion() is race-safe — if 30 students hit this endpoint at once for the
    // same parent question, only one of them actually calls the LLM; the rest wait on that same
    // in-flight generation instead of firing duplicate calls. In practice this is usually just a
    // cache read, since pre-generation kicks off earlier at question:ended (see index.js) rather
    // than waiting until room end.
    const remediationQuestions = []
    let failedCount = 0

    for (const qid of sortedWrongIds) {
      const parentQuestion = parentMap.get(qid)
      if (!parentQuestion) continue

      const remQ = await ensureRemediationQuestion(roomId, parentQuestion, provider)
      if (remQ) {
        remediationQuestions.push(remQ)
      } else {
        failedCount++
      }
    }

    // Don't hand back follow-ups this student already answered (page refresh / back button after
    // finishing) — otherwise they'd be asked again and every submit would 409. If they've answered
    // everything the list is empty and the page sends them straight to results.
    let unanswered = remediationQuestions
    if (remediationQuestions.length > 0) {
      const done = await Response.find({
        roomId, studentId, isRemediation: true,
        questionId: { $in: remediationQuestions.map(q => q._id) }
      }).select('questionId').lean()
      const doneIds = new Set(done.map(d => String(d.questionId)))
      unanswered = remediationQuestions.filter(q => !doneIds.has(String(q._id)))
    }

    // If our own timeout middleware already gave up and responded (see index.js's
    // requestTimeout) while we were still waiting on generation, headers are already sent —
    // calling res.json() again would throw and, from inside a catch block, crash the process.
    if (res.headersSent) return

    res.json({
      success: true,
      // Never ship which option is correct (or the explanation) before the student answers —
      // /submit returns correctOption + explanation once they have.
      questions: unanswered.map(({ explanation, options, ...rest }) => ({
        ...rest,
        options: (options || []).map(({ isCorrect, ...opt }) => opt)
      })),
      // Lets the frontend say "we couldn't prepare N of your remediation questions" instead of
      // silently handing back fewer questions than the student expects.
      failedCount
    })

    // The results snapshot for this room was very likely built (and cached for SNAPSHOT_TTL_MS)
    // BEFORE this remediation question existed — e.g. pre-warmed at room end, or built by whoever
    // hit results first. Without dropping it, this student's freshly-generated (or newly-failed,
    // now-excluded) remediation question never shows up on their results page until the cache
    // happens to expire. Fire-and-forget, after the response so it doesn't add latency to /generate.
    if (remediationQuestions.length > 0) {
      invalidateSoon(roomId)
    }
  } catch (error) {
    console.error('[remediation] Error:', error)
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate remediation questions' })
  }
})

// POST /api/remediation/submit
// Student submits answer to a remediation question — immediate feedback with explanation
router.post('/submit', authorize('student'), async (req, res) => {
  try {
    const Question = (await import('../models/Question.js')).default
    const Response = (await import('../models/Response.js')).default
    const Room = (await import('../models/Room.js')).default

    const RoomMember = (await import('../models/RoomMember.js')).default

    const { roomId, questionId, selectedOptions, responseTime, timedOut } = req.body
    const studentId = req.user._id
    // The timer ran out with nothing chosen: recorded as a wrong answer (selectedOption -1 matches no option).
    const didTimeOut = timedOut === true

    if (!roomId || !questionId || !Array.isArray(selectedOptions) ||
        selectedOptions.length !== 1 || !Number.isInteger(selectedOptions[0])) {
      return res.status(400).json({ error: 'roomId, questionId and a single selectedOptions index are required' })
    }

    const room = await Room.findById(roomId).select('code endedAt').lean()
    if (!room || !room.endedAt) return res.status(409).json({ error: 'Room has not ended yet' })

    const isMember = await RoomMember.findOne({ roomId, studentId })
    if (!isMember) return res.status(403).json({ error: 'Not a member of this room' })

    const question = await Question.findById(questionId).lean()
    if (!question || !question.isRemediation || question.generationStatus !== 'ready' ||
        String(question.roomId) !== String(roomId)) {
      // Also guards against a stale client reference to a still-generating/failed placeholder
      // (empty options array), which would otherwise silently mark every answer wrong.
      return res.status(404).json({ error: 'Remediation question not found' })
    }

    const idx = selectedOptions[0]
    if (didTimeOut ? idx !== -1 : (idx < 0 || idx >= question.options.length)) {
      return res.status(400).json({ error: 'Invalid option' })
    }

    // Only students who actually missed the parent question get to answer its follow-up.
    const missedParent = await Response.exists({
      roomId, studentId, questionId: question.parentQuestionId,
      isCorrect: false, isRemediation: { $ne: true }
    })
    if (!missedParent) return res.status(403).json({ error: 'No follow-up for this question' })

    // Check if already answered
    const existing = await Response.findOne({ roomId, questionId, studentId })
    if (existing) return res.status(409).json({ error: 'Already answered this remediation question' })

    const selectedOptionData = didTimeOut ? null : question.options[selectedOptions[0]]
    const isCorrect = didTimeOut ? false : (selectedOptionData?.isCorrect || false)
    // Follow-ups are practice: correctness is recorded and shown, but they are worth no points and
    // are flagged so every score / rank / class statistic ignores them.
    const points = 0
    const correctOption = question.options.findIndex(o => o.isCorrect)

    const response = new Response({
      roomId,
      questionId,
      studentId,
      selectedOption: selectedOptions[0],
      selectedOptions,
      isCorrect,
      responseTime: responseTime || 0,
      points,
      isRemediation: true
    })
    await response.save()

    // A remediation answer happens after the room has ended — i.e. after the results snapshot for
    // this room was already built and cached. Without this, a student who finishes their
    // remediation flow and immediately checks results can get served the frozen pre-remediation
    // snapshot (missing this answer entirely) for up to SNAPSHOT_TTL_MS. Drop it so the next
    // results-page load rebuilds fresh. Best-effort: a failure here shouldn't fail the submit.
    invalidateSoon(roomId)

    // A teacher who's already sitting on the results page (having ended the room a while ago) has
    // no other way of finding out a remediation answer just came in — nothing re-polls after room
    // end. Broadcast it so their page can refresh itself instead of needing a manual reload.
    // Best-effort: a broadcast failure shouldn't fail the student's submit.
    try {
      if (room?.code) {
        req.app.get('io')?.to(room.code).emit('remediation:submitted', {
          roomId,
          questionId,
          studentId,
          isCorrect,
          points
        })
      }
    } catch (broadcastErr) {
      console.error('[remediation] Failed to broadcast submission:', broadcastErr.message)
    }

    if (res.headersSent) return

    res.status(201).json({
      success: true,
      isCorrect,
      points,
      correctOption,
      explanation: question.explanation
    })
  } catch (error) {
    console.error('[remediation] Submit error:', error)
    if (!res.headersSent) res.status(500).json({ error: 'Failed to submit answer' })
  }
})

export default router