# Notes for Claude sessions on this repository

## Release notes — update every time
At the end of every conversation in which anything changed (code, docs, decisions, answers to open
questions), add it to `docs/RELEASE_NOTES.md`:

- Use the **Phoenix (UTC−7, no daylight saving) date** of the work as the section heading, `## YYYY-MM-DD`,
  newest section first. Add to today's section if it already exists.
- Write for the project owner: what changed and why, in plain words; mention decisions and answered
  questions, not only code. Link requirement IDs (`ORA-03`) and PRs (`hltsai9/GI#1`) where useful.
- Commit the notes together with the work they describe.

## Other conventions
- Open questions live in `docs/TODO.md`; tick them off and record the answer in the URD / build plan.
- Requirements are in `docs/URD.md`, design and data model in `docs/BUILD_PLAN.md`.
- The UI must look like `design/mockups/Garment Inventory App.dc.html`: Broadsheet styles
  (`frontend/src/styles/broadsheet.css`, unchanged copy) plus the mockup's layout.
- After changing what the demo shows, refresh it: `cd backend && npm run demo && npm run export:demo`.
