import mongoose from 'mongoose'

const responseSchema = new mongoose.Schema({
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room',
    required: true
  },
  questionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Question',
    required: true
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  selectedOption: {
    type: Number,
    required: true
  },
  selectedOptions: {
    type: [Number], // Array for MSQ - stores all selected option indices
    default: []
  },
  isCorrect: {
    type: Boolean,
    default: false
  },
  responseTime: {
    type: Number,
    default: 0
  },
  points: {
    type: Number,
    default: 0
  },
  // True for follow-up (remediation) answers. These are practice: they never count toward points,
  // rank, correct rate, answered counts or any class statistic. Queries that compute those use
  // `isRemediation: { $ne: true }` so older responses (no field) still count as class answers.
  isRemediation: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
})

// Index for fast lookups
responseSchema.index({ roomId: 1, questionId: 1, studentId: 1 }, { unique: true })
// Index for leaderboard queries
responseSchema.index({ roomId: 1, studentId: 1, points: -1 })
// Student-centric queries (stats, room history, distinct rooms) filter by studentId alone;
// the compound indexes above start with roomId, so they can't serve these — hence a COLLSCAN without this.
responseSchema.index({ studentId: 1 })

const Response = mongoose.model('Response', responseSchema)

export default Response
