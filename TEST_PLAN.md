# F-QA-12 Inspection App — Manual Test Plan

## Scope

`npm test` covers the app's pure logic (date/column formatting, batch-registry merging,
batch-number generation, card rendering) with zero external dependencies. It does **not**
and cannot cover anything below — these need a real device, a real PIN, a real camera, or a
real round-trip to the live Google Sheet. Run this plan by hand before any release that
touches PIN flows, photo capture, batch continuation, or the Sheet write path.

Use a real phone on factory WiFi where noted — desktop Chrome will not reproduce the
hang/memory issues this app has previously shipped fixes for.

---

## 1. Golden path

1. Open the app fresh (clear site data first, or use a private window).
2. Pick a product, today's date, "Approval Sample" shift.
3. Enter Prepared By + PIN → Begin Inspection.
4. For each process: select operator, answer every check (mix of PASS/FAIL/No Run/manual
   entry where applicable), attach at least one photo.
5. Reach Review → confirm every entered value displays correctly → Submit for Verification.
6. **Expected:** "Submitted for Verification" screen; `S.submitStatus` reaches `done` (check
   for the green "✅ Submitted" banner, not just that the screen changed).
7. Open the live Google Sheet directly — confirm a new row appeared with the correct Batch
   No., all check values, and a populated "Last Saved At" cell.

## 2. Data-loss guards

These exist because of a real production incident — treat any failure here as release-blocking.

1. **App Back button, mid-inspection:** Start an inspection, answer a few checks, tap the
   first process's "← Back" button.
   **Expected:** a confirmation dialog naming the reading count appears — does NOT silently
   drop to Setup. Choose "stay" → data intact. Choose "leave" → routes through the pause
   checkpoint, not a raw discard.
2. **Hardware/gesture Back, mid-inspection:** Same setup, press the phone's physical Back
   button (Android) or swipe-back (iOS).
   **Expected:** same confirmation as above — the page must not actually navigate away.
3. **"Begin Inspection" while a session is already live:** Get partway through an
   inspection, navigate back to Setup some other way, tap "Begin Inspection" again.
   **Expected:** a warning naming the reading count, requiring explicit confirmation before
   wiping.
4. **Force-quit / kill the app mid-process:** Fill a few checks, force-quit the browser tab
   (don't use any in-app navigation), reopen the URL.
   **Expected:** "Unfinished Inspection Found → Resume" prompt; Resume restores the exact
   process, operator, and readings you had.
5. **localStorage quota exhausted:** Visit the Inspection Log (loads up to 500 Sheet rows
   into memory) a few times to grow cached state, then continue an inspection.
   **Expected:** if a save ever fails, a visible red warning banner appears — saves must
   never fail silently.

## 3. Photo capture (real device required)

1. On a mid-range Android phone on factory WiFi, capture a photo for a check.
   **Expected:** no multi-second UI freeze; the badge shows "uploading" then "attached."
2. Capture a photo in portrait vs. landscape orientation.
   **Expected:** the uploaded photo is right-side-up (not sideways) — this depends on
   `imageOrientation: "from-image"` being honored.
3. Force a bad network mid-upload (airplane mode toggle).
   **Expected:** badge shows "Upload failed · tap to retry," not a stuck spinner.

## 4. Continue Existing Batch

1. Start a batch on Device A, pause it (⏸ Save Progress & Continue Later) before finishing.
2. On Device B (different browser/phone), open the app, check "Continue Existing Batch."
   **Expected:** the batch appears, sorted at or near the top (newest-worked-first), with a
   `DD-MM-YYYY, HH:MM AM/PM` last-worked time and correct per-shift status badges.
3. Type a search term matching the batch number → confirm it filters correctly.
4. Type a search term matching nothing → confirm the search box and "no matches" message
   both remain visible (not the whole section disappearing).
5. Tap the card → confirm it highlights, then Continue This Batch → confirm it resumes at
   the correct process, not process 1.
6. Repeat the whole flow for a batch spanning 2+ calendar days — confirm the day counter and
   batch number suffix are correct.

## 5. Verify Reports (supervisor flow)

1. From Setup, open Verify Reports, enter the shared PIN.
2. Pick a submitted report, verify a process, confirm it moves `Verified Thru Process`
   forward on the batch card the next time an operator views it.
3. Confirm a non-Approval-Sample shift stays gated ("capped") until Approval Sample is at
   least partially verified — try to push past the cap and confirm it's blocked with a clear
   message.

## 6. Edge cases worth a periodic manual pass

- **Separate same-day run collision:** start a second, genuinely separate batch for the same
  product+date → confirm the `-A` suffix path works and doesn't silently merge with the
  first run's data.
- **No Run cascade:** mark Part Off (090) Length as "No Run" → confirm every downstream
  process auto-fills as No Run and the batch routes straight to submission.
- **Continuing a batch on a new calendar day after it was finalised the day before:**
  confirm it starts a genuinely fresh pass (process 1, no stale prefilled answers), not a
  reopen of the finalised day.

---

## 7. Once the audit's Critical findings are addressed, also verify

*(Not yet applicable — listed here so it isn't forgotten once those fixes ship.)*

- After `/api/log` and `/api/submit` gain real authentication: confirm every existing flow
  above still works end-to-end with auth wired through, and confirm an unauthenticated
  direct call to either endpoint is now rejected.
- After the Verify Reports PIN moves server-side: confirm the client no longer contains the
  literal PIN value anywhere (view-source check), and that entering the correct PIN still
  works.
- After HTML-escaping is added to Sheet-sourced display text: re-run the "badge text is not
  escaped" case in `test/card-rendering.test.js` — it should start failing (which is the
  point — flip that test's assertion once the gap is actually closed).
