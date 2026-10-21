/**
 * One-time backfill: follow-up (remediation) answers are practice and no longer count toward points,
 * rank or class statistics. New answers are flagged `isRemediation: true` (and saved with 0 points)
 * automatically; this script does the same for answers saved BEFORE that change, so old rooms stop
 * counting them too.
 *
 * SAFE BY DEFAULT: dry-run (prints how many responses would change, writes nothing). Pass --apply to write.
 *
 *   node backend/scripts/backfill_remediation_flag.js            # dry-run
 *   node backend/scripts/backfill_remediation_flag.js --apply    # perform the update
 *
 * Uses MONGODB_URI (falls back to mongodb://127.0.0.1:27017/spandan). Run OFF a live session.
 * Idempotent: safe to run more than once. After applying, results caches rebuild on their own
 * (snapshots expire after ~10 min; or end/reopen nothing — just reload the results page later).
 */
import mongoose from 'mongoose'
import Question from '../src/models/Question.js'
import Response from '../src/models/Response.js'

const APPLY = process.argv.includes('--apply')
const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/spandan'

async function main() {
  await mongoose.connect(URI)
  console.log(`Connected: ${URI}  |  mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`)

  const remediationIds = await Question.distinct('_id', { isRemediation: true })
  console.log(`Remediation questions found: ${remediationIds.length}`)

  const filter = { questionId: { $in: remediationIds }, isRemediation: { $ne: true } }
  const toFix = await Response.countDocuments(filter)
  const withPoints = await Response.countDocuments({ ...filter, points: { $gt: 0 } })
  console.log(`Responses to flag as practice: ${toFix} (${withPoints} of them currently carry points that will be zeroed)`)

  if (APPLY && toFix > 0) {
    const r = await Response.updateMany(filter, { $set: { isRemediation: true, points: 0 } })
    console.log(`Updated ${r.modifiedCount} responses.`)
  } else if (!APPLY) {
    console.log('Dry-run only. Re-run with --apply to write.')
  }
  await mongoose.disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
