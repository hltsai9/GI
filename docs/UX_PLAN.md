# Phone UX review and improvement plan

Reviewed 2026-11-24 on an iPhone 13–sized screen (390 × 844), as floor staff and as admin, with the demo data.
Screenshots: [docs/ux-review](./ux-review/). Requirements: [URD](./URD.md). Nothing here is built yet; the
decisions marked **(your call)** need an answer first.

## Who uses it on a phone, and when

| Person | Moment | What they need from the phone |
|---|---|---|
| Floor staff | ~06:40, unloading the truck, gloved, standing | Enter a delivery fast and correctly; ~45–75 lines a day in the demo data |
| Floor staff | Spot check / full count at the shelves | Enter many counts in a row, see progress, not lose work |
| Lead | Walking the floor, between meetings | "What's low?", "how many issued today?", answer in seconds |
| Admin | Occasionally | Upload files, map values, check alerts (often easier on a laptop) |

The design should favour the first row: it happens every day, under time pressure, in gloves.

## What works well

- One clear job per tab, with a heading that says where you are ("Receive · Off truck", "Stock · On hand").
- **Receive** keeps the running total and **Post delivery** pinned at the bottom, within thumb reach.
- **Stock › Summary** answers "how much do we have" at a glance: big numbers per garment and location, days of
  cover, today's in/out, then a reorder list sorted by urgency.
- Tap targets are at least 44 px everywhere (checked automatically), and numbers use tabular figures.
- Units (pieces / pairs) are shown next to quantities.

## Problems found (most important first)

### 1. Entering a delivery takes too many taps (Receive) — high impact
- Each line needs four dropdowns (garment, color, size, location), a quantity and **Add line**. With 13 sizes the
  size list scrolls ([screenshot 5](./ux-review/5-receive-dropdown.jpg)).
- The demo deliveries have 45–75 lines each. At ~6–8 taps per line that is 300–500 taps every morning. The URD
  target (a 5-line delivery in under 2 minutes) is met, but a real delivery is ten times longer.
- The form starts on the first size (XSM) and the first location every time, instead of what is usually delivered.

### 2. Text inputs make iPhones zoom in
- Inputs use 14–15 px text. iOS Safari zooms the page in when a field under 16 px gets focus, so after typing a
  quantity the page is zoomed and must be pinched back. This affects every number field (Receive, Correct stock,
  Full count, Stock › Grid minimum).

### 3. Grids are cramped and show empty space (Stock › Grid, Trends › Daily grid, Full count)
- With 7 colors, column headers are cut off ("WHI…", "OTH…").
- Columns and rows that have no stock at all (Grey, ESD, UNI; sizes 5XLG–7XLG, UNI, Other) take most of the space.
- Tapping a cell shows its details **below** the grid, off-screen, so nothing seems to happen.
- Daily grid cells stack two small numbers (+5 / −3) that are hard to read.
- Full count is a wall of 91 identical boxes per garment type, with no total and no sign of which garment types
  are already counted.

### 4. Settings is hard to move around in
- Seven sections are hidden behind one **Section** dropdown; floor staff use only three of them.
- **Correct stock** lists the 20 latest corrections under the form; after go-live they are all starting-count rows,
  so the list is long and not useful.
- Admin pages (Import, Data quality) open with long paragraphs of help text; the action buttons are far down.
- Wide tables run off the right edge (Data quality "Where", Import "Recent runs" status column).
- Data quality shows raw Oracle codes (`FAB1,FAB2`) where the rest of the app says P1 / P2.

### 5. Trends needs work on a small screen
- Three control rows (view, range, then the chart's own options) come before any number.
- Line charts have no axis values; the read-out needs a touch-and-drag the user has to discover.
- The most useful numbers (issued today / this week, delivered this week) are not visible without scrolling.

### 6. Smaller points
- Small text: tab labels 11.5 px, section labels 11 px, table headers ~10 px uppercase. Hard to read in a
  cleanroom suit and visor.
- A viewer's phone opens on **Receive**, where they cannot do anything; the lead usually wants **Stock** first.
- The header says "P1 + P2" on every screen, but a floor worker works in one location.
- Grid cell states (below minimum / close / plenty) are shown by color only.
- "Unregistered P1: −207" reads like an error; it needs a short explanation in place.

## Plan

### Phase 1 — quick fixes (about 2 days, no change to the mockup's layout) — **done 2026-11-24**
Built as planned, with these choices:
- the quantity field is selected right after choosing a **size or color** (the next thing typed), not after
  **Add line**, so the keyboard does not cover the form after each line;
- Full count keeps every size and color (counting needs them all), but gets the readable column names;
- the Daily grid's two numbers per cell stay for now (Phase 3.4).

1. Inputs at 16 px on phones (stops the iPhone zoom).
2. Text size: tab labels, section labels and table headers at least 13 px on phones.
3. Grids: hide colors and sizes that are empty everywhere for that garment and location, with a "Show all" switch;
   full column names (rotate or abbreviate with a legend: WH, BU, BK…).
4. Grid cell details open in a **bottom sheet** over the grid instead of below it.
5. Receive remembers the last garment, color, size and location; quantity field selected after **Add line**.
6. Correct stock: show the 5 latest corrections, without starting-count rows, with "Show more".
7. Admin help text collapsed behind "How this works"; tables become stacked cards on phones; Data quality shows
   P1 / P2 instead of Oracle codes.
8. Open on the right tab per role: floor staff → Receive, lead and viewer → Stock.
9. Grid states also marked with a small icon or text, not only color.

### Phase 2 — faster deliveries (the biggest win; about 3–4 days)
1. **Grid entry for deliveries**: choose garment and location once, then type quantities in a size × color grid
   (like Full count, with large steppers and only the usual sizes and colors shown). One garment type per screen,
   with a total; switch garment type without losing entries.
2. **Usual sizes and colors first**: order the choices by how often they were delivered in the last 30 days.
3. **Review before posting**: a summary per garment and location ("Gowns P1: 120 pieces in 9 lines"), then Post.
4. **"My location"** on This device **(your call)**: preset Receive, Stock › Grid and Full count to P1 or P2 on that
   phone; the header shows it.
5. Measure: time a real morning delivery before and after with floor staff; target under 5 minutes for 60 lines.

### Phase 3 — Stock and Trends for the lead (about 3 days)
1. Trends opens with three number cards (issued today, issued this week, delivered this week), then the charts.
2. One control row: view + range in a single compact row; chart options inside the chart card.
3. Charts: axis values, tap a bar or point to show its value (no drag needed).
4. Daily grid: one number per cell with a Delivered / Issued / Net switch, instead of two stacked numbers.
5. Stock: explain "Unregistered" in place (tap for details), and link each reorder line to its grid cell.

### Phase 4 — counting and Settings (about 2–3 days)
1. Settings home as a list of sections (one tap each), showing only the sections the user can use.
2. Full count with progress ("Gowns ✓ · Hoods 40 % · Boots —"), totals per garment, and a review step before saving.
   Counts typed but not saved survive leaving the page.
3. Correct stock: pick the item from the grid (tap a cell) instead of four dropdowns.

### Decisions needed **(your call)**
- **Bottom navigation bar.** On phones the tabs are at the top, as in the mockup. A bar at the bottom is easier to
  reach with one hand. This changes the mockup layout, so it needs your OK.
- **"My location" per device** (Phase 2.4): do floor staff always work in one location?
- **Grid entry for deliveries** (Phase 2.1): does the delivery paperwork list garments by size and color, so a grid
  matches how staff read it? If it is a list of lines, a faster line entry may fit better.

### How to check each phase
- Screenshots on a 390 px phone for every changed screen (as now), plus one real iPhone and one Android.
- A timed test with one floor worker entering a real delivery (Phase 2), and the lead answering three questions
  (Phase 3): "what is low?", "how many gowns issued today?", "how many delivered this week?".
