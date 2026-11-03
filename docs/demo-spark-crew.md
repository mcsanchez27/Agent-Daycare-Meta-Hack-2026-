# Spark Crew demo (3 minutes)

One take: Spark leads, Claude builds, Preview shows the result.

## Before you start

- `.env.local` in this folder has `BASETEN_API_KEY`, `BASETEN_BASE_URL`, `META_SPARK_MODEL` (never commit it).
- Claude CLI is installed and logged in (`claude`).
- `npm test` is green, then `npm start`.

## Script

1. New chat -> **Spark Crew (demo)**. Two members: Spark (Design), Claude (Engineering).
2. Send this to Spark:

   > Spark, lead this build. In chat (no files), post a short brief for a one-page Pomodoro timer: goal, 3 features, what is out of scope. Then put @Claude alone on its own last line to hand over. Claude: build the brief as a single self-contained `index.html` in this chat's folder (inline CSS/JS, start/pause/reset, 25-minute default), then say what you built and what you did not test.

3. Watch Spark stream its brief, then Claude take the handoff and write the file (about 1-2 minutes).
4. Open the Preview tab and load `index.html`. Start the timer. Done.

## If time runs short

- Cut the timer to a static page with a working start button. One file, one handoff, Preview still proves it.
- If Spark is slow, send the same prompt to Claude alone and narrate Spark's role from the brief step. Do not fake a connection state.

## Not verified by tests

The live Baseten call and the Claude CLI launch only happen in the app. Tests cover the crew preset (`test/members.test.js`) and the existing handoff rules; the 3-minute take itself is a manual app check.
