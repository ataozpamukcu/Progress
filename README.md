# Course Progress Dashboard

This is a lightweight local dashboard for tracking progress across:

- 3rd Year Project
- Quantum Mechanics 2
- General Relativity
- Fundamentals of Nanotechnology
- Condensed Matter

## Open it

The safest way to use the tracker is with the bundled local save server. The easiest option is to double-click [start-tracker.command](start-tracker.command).

If you want to do it manually, from this folder run:

```bash
node server.js
```

Then open `http://127.0.0.1:8787`.

The tracker stores all progress in `data/progress-state.json`. That file is the source of truth.

Do not use the raw HTML files as your normal entry point. Use the launcher or the local server URL so the page can talk to the save file properly.

## How it works

- Each course has weighted groups.
- The `Study Plan` page holds the big ordered rescue list with detailed checkboxes and its own saved progress.
- Main course progress usually excludes past papers, unless you have deliberately mirrored them into a main revision block like Quantum Mechanics 2.
- Past papers are tracked on their own separate page, and shared paper items can stay synced with the course page.
- Project milestones and exams now have their own completion checkboxes.
- When you mark a deadline or exam completed, it moves to the `Completed` tab and the related work collapses out of the active view.
- Checking tasks off updates the progress bar automatically.
- When you tick a task complete, that completion is automatically written into the daily study log for today's date.
- The daily study log lets you record what you did on each date and leave yourself a reminder for next time.
- Your checkbox state, notes, and study log are written to `data/progress-state.json`.
- When the save file is unavailable, editing is locked instead of silently falling back somewhere else.

## If Progress Looks Missing

- Start the bundled server with `node server.js` and use `http://127.0.0.1:8787`, or just double-click `start-tracker.command`.
- Check the banner at the top of the page. If it says `File save active`, edits are reading from and writing to `data/progress-state.json`.
- If it says `File save unavailable`, start the tracker server again before editing anything.

## Current weighting assumptions

- 3rd Year Project
  - Literature review and planning: `20%`
  - Research / implementation: `35%`
  - Poster submission: `15%`
  - Thesis / report writing: `20%`, internally weighted by section word-count midpoint
  - Oral and poster presentation: `10%`
- Quantum Mechanics 2
  - Quantum Revising: `60%`
  - Quizzes: `40%`
  - Biweekly problem sets: optional
  - Includes 9 past papers plus WKB-focused revision in the main course tracker
  - The 9 past papers are mirrored on the Past Papers page with shared checkbox state
  - Exam: `12 May 2026`
- General Relativity
  - Lectures: `50%`
  - Problem sets: `50%`
  - Past papers: tracked separately
  - Exam: `27 May 2026`
- Fundamentals of Nanotechnology
  - Classical Computing: `25%`
  - Quantum Computing: `25%`
  - Next 5 problem classes: `10%` each
  - Past papers: tracked separately
  - Exam: `21 May 2026`
- Condensed Matter
  - Topics: `100%`
  - Past papers: tracked separately
  - Exam: `20 May 2026`

## Edit the tracker

If you want to change task names, weights, or the number of past papers later, edit the course definitions near the top of [app.js](app.js).
