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
  (`frontend/css/broadsheet.css`, unchanged copy) plus the mockup's layout.
- After changing what the demo shows, refresh it: `cd backend && python -m gi.cli.demo && python -m gi.cli.export_demo`.
- Stack: Python backend (`backend/gi`, FastAPI + SQLAlchemy Core over PyMySQL, packages in the root
  `requirements.txt`), and a no-build web page (`frontend/`: plain HTML, CSS and JavaScript modules).
  Do not add Node.js, npm or a frontend build step; the company CI builds the image from a Python base image.
- Tests: `cd backend && python -m pytest` (needs the `gi_test` MariaDB database);
  `node --test frontend/tests/*.test.mjs` is an optional check. A new file in `frontend/js` must also be
  added to the `modulepreload` list in `frontend/index.html` (a test checks it).
