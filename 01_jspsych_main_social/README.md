# Main experiment: social influence on label adoption

Two participants (a naive participant and a confederate) sit at two computers in the lab and take part in the same session. Startup, Phases 1/2, solo-test simulation, and browser synchronization are implemented. Phase 3 and the post-experiment questionnaire remain a skeleton; real ID management, server saving, and consent resources still need to be copied/adapted from the Exp2 pre-study (see below).

## Folder structure

| Path | Content | Status |
|---|---|---|
| `main_social.html` | The experiment timeline (jsPsych 7.2.3), startup, participant intake, Phases 1/2, and saving. Phase 3 remains `TODO`. | partly implemented |
| `resources/experiment_config.js` | All changeable parameters: conditions, timing, trial numbers, confederate behaviour, stimuli file. | to fill in |
| `resources/experiment_setup.js` | Experimenter-only run type, role, condition, and session entry screens. | implemented |
| `resources/phase1.js` | Shared stimulus plan, image loading, Phase 1 screens, solo simulation, and per-picture response records. | implemented |
| `resources/phase2.js` | Sender-receiver task, Phase 1 label linkage, scripted feedback, solo simulation, and per-attempt records. | implemented |
| `resources/phase3.js` | Placeholder for participant-only private naming, following the Phase 1 organization. | comments only |
| `resources/pair_sync.js` | Browser communication, partner waiting, and local solo-test simulation. | implemented |
| `sync/sync.php` | Locked shared store of both participants' responses and session condition (PHP 7.3+). | implemented |
| `stimuli/concepts.csv` | 20 concepts from Exp2, one row each: `concept_nr`, `concept_id`, `image`, `good1`-`good4`, `bad1`-`bad4` (ordered by SigLIP2 cosine), `labels_to_check`. Read by the experiment. | done (provisional) |
| `stimuli/concepts.js` | Generated browser-readable CSV copy for solo previews opened directly as a local HTML file. | generated |
| `tools/build_local_stimuli.py` | Rebuilds the local preview copy after editing `concepts.csv` (Python standard library only). | implemented |
| `stimuli/labels_long.csv` | The same labels, one row per label, with cosine, novelty and how often they were produced in Exp1. | done (provisional) |
| `stimuli/pictures/` | The 20 images (same resized files as Exp2). | done |
| `jspsych/` | Local jsPsych plugins (same as Exp2). | done |
| `ID_management/`, `data/`, `sync/state/`, `sync/state_test/` | Real ID scripts/data and writable synchronization storage. Test runs do not use any ID queue. | infrastructure needed |
| `.gitignore` | Keeps participant data, the live ID list, the sync state and server passwords out of GitHub. Do not delete. | done |

## Setting up the infrastructure (copy from Exp2)

Copy the following from the Exp2 pre-study, `02_pre_study_goodness_ratings/01_jspsych_Exp2_goodness_ratings/`, into this folder, then adapt them as described. Read each file while you do it: `main_social.html` expects exactly these paths and names.

| Copy from Exp2 | Put here as | Adapt |
|---|---|---|
| `resources/informed-consent.js`, `resources/browserCheck.js` | `resources/` | nothing |
| `resources/humboldt_logo.png` (missing in Exp2 - take it from Exp1, `01_jspsych_Exp1_labels/resources/`) | `resources/` | nothing |
| `resources/informedconsent_ratings_de.html` | `resources/informedconsent_social_de.html` | procedure, duration and payment for the lab study; replace the Prolific ID parts in the data-protection section by the pair code; do not reveal the confederate. Keep the radio buttons and the `start` button. |
| `save_data.php` | same name | nothing; tests offer a local CSV download and do not call a save endpoint |
| `ID_management/manageID_ratings.php`, `cleanupID_ratings.php`, `IDs_ratings.txt` | `ID_management/manageID_social.php`, `cleanupID_social.php`, `IDs_social.txt` | file name `IDs_social.txt` inside both scripts; in `cleanupID_social.php` look for `../data/social_<ID>_naive_*.csv` (only the naive participant frees the ID); one line per **pair** in `IDs_social.txt` |
| `start_local_test.bat` | same name | open `main_social.html` instead of `test.html`; PHP is required for real or paired runs. Solo tests also work with a static HTTP server. |
| `.vscode/settings.json` | same name (optional) | nothing |

The folders already exist (empty, apart from a `.gitkeep` file that only makes Git keep the empty folder), and `jspsych/` already contains the plugins. Whatever is written into `data/`, `data_test/` and `sync/state*/` during the experiment stays out of GitHub (`.gitignore`).

## Starting the experiment

Open **`main_social.html` without URL parameters**. The startup screens are for the experimenter, before handing the computer to the participant. Old `role`, `pair`, and `test` URL parameters are no longer read.

1. Select **Test run** or **Real data collection**.
2. Select **Participant** (internally `naive`) or **Confederate**.
3. Complete the mode-specific options and click **Complete setup**. The next screen shows the session details; click **Start** when ready to begin the participant-facing sequence.

Experimenter-only screens, test controls, and confederate screens are in English. Participant-facing instructions, consent, demographics, and required-answer messages remain in German. Condition values are **`assertive`** and **`compliant`** throughout the task, synchronization state, and CSV data; their displayed labels are **Assertive** and **Compliant**.

For a **real session**, prepare the participant's computer first. It obtains a pair ID from `ID_management/IDs_social.txt` and displays it. On the second computer select real data collection and Confederate, and enter that ID in the form. The condition still follows from the pair ID (`getCondition()`). Only the real participant's browser calls ID cleanup, after data saving succeeds. Failed startup/saving requests display an error instead of silently advancing. Real participant runs require the consent form and the PHP infrastructure above. The confederate neither loads nor sees the consent form and skips demographics.

For a **solo test**, select Test run and **Test alone (simulate partner)**, choose either role and a condition. A fresh temporary `test-...` session code is generated. No ID allocation, ID cleanup, synchronization, or server-saving requests are made. For participants, a missing consent form is replaced by an explicitly marked test placeholder; the German demographics survey follows consent in both test and real runs. Confederates skip both screens. The final screen offers a `TEST_social_<session>_<role>_<timestamp>.csv` download. A banner identifies the test throughout the run.

Solo tests can also be opened by double-clicking `main_social.html`. Browsers block `fetch()` of CSV files from local HTML pages, so direct-file previews load `stimuli/concepts.js` as a normal script instead. HTTP/HTTPS sessions always read `concepts.csv` directly; they do not silently substitute the preview copy if a server request fails. In a direct-file participant preview, consent is represented by the test placeholder. Real sessions and two-browser tests require a PHP server. The existing CDN scripts still require internet access.

After manually editing `stimuli/concepts.csv`, refresh its generated preview copy by running this from the experiment folder:

```powershell
python tools/build_local_stimuli.py
```

`00_stimuli_selection/select_stimuli_main.py` runs this builder automatically when it regenerates the CSV. The regression tests also check that the preview copy matches the CSV.

For a **two-browser test**, serve the folder through the same PHP server on both computers. On the first select Test run, Participant, **Test with two browsers**, and a condition. On the second select Test run, Confederate, **Test with two browsers**, and enter the first computer's temporary session code. The confederate automatically inherits the condition. Sync files go exclusively to `sync/state_test/`; ID management and server data saving remain disabled. Start each fresh test from a new participant setup to avoid reusing old partner responses.

Every data row contains `pair_id` (null in tests), `session_id`, `role`, `condition`, `test_mode`, and `connection_mode` (`solo` or `paired`). Real data filenames remain `data/social_<pair>_<role>_<timestamp>.csv`; merge the two files by `pair_id` in the analysis.

**Scope of testing:** Phases 1 and 2 are implemented for both roles, including solo simulation. Their simulated partner uses the selected labels and each trial's current strategy. The current timeline still has TODOs for Phase 3 and the questionnaire. Simulated responses are only for checking program flow.

## Phase 1: stimulus selection and procedure

The participant's browser samples **16 distinct pictures from the 20 rows in `stimuli/concepts.csv`**, shuffles their order, and publishes one shared plan. The confederate downloads that plan instead of sampling independently. A solo test creates the same kind of plan locally, for either role. The research pair ID determines the base condition, not the picture set.

Defaults are in `resources/experiment_config.js`:

- `n_concepts: 16`: 16 pictures in total.
- `phase1.n_fillers: 3`: 13 regular trials and 3 randomly positioned fillers.
- `phase1.label_policy: 'balanced'`: 8 good and 8 bad confederate labels. `good1`-`good4` and `bad1`-`bad4` are each used twice, assigned randomly to the selected pictures. Quality is balanced over all 16 trials; filler assignment is independent.
- `timing.phase1_label_entry_ms: 120000`: up to two minutes for label generation.
- `timing.phase1_discussion_ms: 60000`: one minute for discussion.

Both computers preload the selected images during startup. Then, after the participant's consent and demographics:

1. Each person reads their role-specific Phase 1 instructions.
2. Both browsers become ready before the image is revealed. The participant enters a label; the confederate sees their preselected label in a read-only field and submits it. The confederate also sees the strategy to use on this trial. No labels are exchanged on screen until both entries are complete.
3. Both labels are revealed for the one-minute discussion. On regular trials, Assertive means advocate/select the confederate's label and Compliant means support/select the participant's label. Fillers reverse this strategy. Only the confederate sees this guidance.
4. Discussion ends before individual choice begins. Participants can choose either label; the confederate's buttons enforce the current strategy. Choice origin is recorded even if the two words are identical.
5. Both choices are revealed only after both people have chosen. Each presses Continue/Weiter; the next picture waits for both browsers again.

At the generation deadline, any partial input is retained; a blank response is recorded as null. A timeout is explicitly marked and has no submission RT. Missing participant labels cannot be chosen; the confederate falls back to their own label and the row records that exception.

Each picture produces one `phase: 'phase1'` row in each person's CSV. Key columns:

| Column | Meaning |
|---|---|
| `trial`, `concept_id`, `stimulus` | Presentation position, concept identifier, and image filename. |
| `participant_label`, `participant_label_rt` | Participant's generated word and submission time in milliseconds from the image/input display. |
| `participant_label_timed_out` | Whether the deadline expired before submission. |
| `confederate_assigned_label`, `label_slot`, `label_quality` | Scripted label, its CSV column, and good/bad quality. |
| `is_filler`, `confederate_strategy` | Filler flag and actual strategy after any reversal. |
| `participant_choice`, `participant_choice_source`, `participant_choice_rt` | Final selected word, whose label it was (`naive`/`confederate`), and time from choice-screen display. |
| `confederate_choice`, `confederate_choice_source` | Confederate's final choice. |
| `own_label`, `partner_label`, `label_rt`, `response`, `choice_source`, `choice_rt` | The same information from the current browser's perspective. |
| `labels_identical`, `choice_matches_confederate_label` | Identical-word flag and whether the participant's final word equals the confederate's word. |
| `phase1_run_id`, `*_scheduled_server_ms`, `generation_onset_server_ms` | Shared run identifier and onset timing for synchronization checks. |

`phase1.results` in `main_social.html` retains these rows for Phase 2 and the future Phase 3. A test CSV remains a local download; real runs still use the configured research saving endpoint.

## Phase 2: sender-receiver behaviour

Phase 2 follows Phase 1 and uses the **same 16 pictures in the same order**, with the same three filler assignments. It reads each concept's actual submitted confederate label from `phase1.results`, rather than selecting another label from the CSV. The participant's Phase 1 label is also retained in the Phase 2 data for comparison.

The participant reads German instructions explaining that the partner sees several similar pictures. Only the participant's computer displays the target picture. The confederate's English screen shows their Phase 1 label, the participant's new label, the current strategy, and **Correct/Incorrect** buttons; it never shows a picture array or the target picture.

1. The participant types a label. There is no entry deadline; response time starts when the picture/input screen appears and ends on submission. Each attempt has a fresh timer.
2. The submitted label is sent to the confederate. In an **assertive** trial, Incorrect is required until it matches the confederate's Phase 1 label. In a **compliant** trial, Correct is required immediately, regardless of the label. Fillers reverse the base condition, just as in Phase 1.
3. The confederate clicks the required feedback button; the other button is disabled. Matching ignores capitalization, surrounding whitespace, and equivalent Unicode composition. It does not remove punctuation, change spelling, or equate different words. The original typed text is retained separately.
4. Both browsers reveal the feedback together. The participant sees whether the correct picture was selected, without an explanation of the scripted rule. Feedback is shown for `timing.phase2_feedback_ms` (default 2000 ms), followed by a synchronization check.
5. Correct feedback advances to the next picture immediately. Incorrect feedback allows another attempt, up to `phase2.max_attempts` (default 3). A third incorrect answer also advances to the next picture. Skipped attempts produce no data rows.

Phase 2 settings and timing are shared by the participant's browser during startup. Message keys include the Phase 1 run, picture position, and attempt number. Network retries reuse the already-recorded label and RT instead of restarting entry. In a participant-only solo test, feedback is simulated using the real rule. A confederate-only test simulates non-matching participant labels, followed by the reference label on the third attempt; compliant trials still end on attempt one.

Each submitted attempt produces one `phase: 'phase2'` row in each browser's CSV, so a picture has one, two, or three rows. Key columns:

| Column | Meaning |
|---|---|
| `trial`, `concept_id`, `stimulus` | Picture position, concept identifier, and image filename. |
| `phase1_run_id`, `phase1_trial` | Link to the same concept/presentation in Phase 1. |
| `phase1_participant_label`, `phase1_confederate_label`, `confederate_label` | Previous participant label and the confederate reference label from Phase 1. |
| `attempt`, `max_attempts` | Attempt number (1, 2, or 3) and allowed maximum. |
| `participant_label`, `participant_label_raw` | Submitted label with outside whitespace trimmed, and the original input including that whitespace. |
| `participant_label_rt`, `label_rt`, `rt` | Time in milliseconds from this attempt's input display to submission. These columns all contain the participant's label RT. |
| `is_filler`, `confederate_strategy`, `label_quality`, `label_slot` | Shared filler/strategy assignment and original good/bad label selection. |
| `label_matches_confederate` | Whether the new label matches the Phase 1 confederate label under the matching rule. |
| `feedback_correct`, `expected_feedback_correct`, `feedback_rt` | Actual/required feedback and the confederate's button-response time in milliseconds. |
| `picture_complete`, `end_reason`, `attempts_remaining` | Whether the picture has ended; `correct`, `max_attempts`, or null; and available remaining attempts. |

`phase2.results` retains these rows for later phases. Both real CSV files contain the participant's submitted labels and RTs as well as the feedback; the `role` column still identifies which browser produced the file. Existing final CSV saving and local test downloads include both phases.

## Architecture: how the two browsers communicate

```
Browser A (jsPsych)  <->  resources/pair_sync.js  <->  sync/sync.php  <->  sync/state/pair_<ID>.json
Browser B (jsPsych)  <->  resources/pair_sync.js  <->        "         <->          "
```

The two browsers never talk to each other directly. Each one writes its responses to a shared JSON file per pair on the server, and reads the partner's responses from it:

1. Participant A enters a label, and `PairSync.sendValue('phase1_label_c1', 'Kreuzhahn')` sends it to `sync.php`, which stores it with a server timestamp.
2. Browser B calls `PairSync.getPartnerValue('phase1_label_c1', ...)`. It asks `sync.php` every 0.5 s ("polling") until the value is there, then continues with exactly that label.
3. Wherever both have to be finished before continuing, both call `PairSync.waitForPartner('<step name>', ...)`. Each browser marks the step as reached and waits until the partner has reached it too.

All synchronization methods return Promises; `getPartnerValue` and `waitForPartner` also support callbacks. `await PairSync.sendValue(key, value)` before depending on delivery. `PairSync.join(sessionID, role, {testMode, solo, condition, simulatePartner})` is awaited during setup. The participant creates the server session and stores its condition; the confederate joins that existing session. Requests time out after 15 seconds, and partner waits after `CONFIG.timing.sync_timeout_ms` (default five minutes, allowing for the two-minute label-entry window). Future phase code should catch rejected Promises and show a recoverable error. Use a unique step/message key for each trial.

Phase 1 uses `PairSync.synchronize(step, leadMs)`: `sync.php` waits for both browsers, then assigns a shared future server timestamp (default 1500 ms ahead). Clients estimate their clock offset and reveal at that timestamp. This reduces polling-related onset differences but is not laboratory-grade frame synchronization. Scheduled and generation-onset timestamps are recorded. Connection failures show a retry screen; already-entered responses and their RTs are kept when the request is retried. Run-specific message keys prevent stale responses from an earlier Phase 1 run from being reused.

**Why PHP with polling instead of WebSockets, Firebase or Supabase:**

- It runs on the HU server we already use for the pre-studies, with the same upload workflow. Participants need nothing but a normal browser.
- WebSockets need a server program (e.g. Node.js) that runs permanently, which normal PHP web hosting does not allow.
- Firebase and Supabase store the data with an external (US) company. That causes data-protection problems and requires changing the consent form.
- With two participants and a few exchanges per minute, a 0.5 s delay is not noticeable in the lab, so real-time push is not needed.

**Separation of logic.** `main_social.html` builds the experiment timeline; `phase1.js` and `phase2.js` contain their respective task logic. `pair_sync.js` and `sync.php` contain communication. Parameters live in `experiment_config.js`. Changing concepts, timing, trial numbers or confederate behaviour should never require touching the sync code.

## Before the first real session

- Create the folders `data/`, `sync/state/` and `sync/state_test/` on the server and make them writable, as for the pre-studies. Test CSVs are downloaded locally.
- Set the number of IDs in `ID_management/IDs_social.txt` to the planned number of pairs.
- Complete the experimental phase TODOs and adapt the consent form.
- Run at least one full test session on the two real lab computers.

## Regression tests

`tests/startup.test.cjs` uses Node.js (22+), Playwright, an installed Edge browser, and PHP (7.3+). It runs against a temporary copy, with fixture consent/ID/save scripts; it does not touch research IDs or data. Install Playwright in your test environment, put `php` on PATH (or set `PHP_BINARY` to its executable), then run from this folder:

```powershell
node --test tests/startup.test.cjs tests/phase1-plan.test.cjs tests/phase2-rules.test.cjs
```

Set `BROWSER_CHANNEL` to use another installed Playwright browser channel. The tests download the page's exact pinned CDN scripts once, so they require internet access. They check English setup/condition labels, German participant demographics and required responses, participant-only consent/demographics in test and real runs, test isolation, local CSVs, paired condition/message exchange, missing infrastructure, invalid IDs, and saving/cleanup failures.

The browser suite also completes all 16 pictures through Phases 1 and 2 on two browsers with shortened test-only timers. It checks privacy, filler reversals, early success, three unsuccessful attempts, cross-phase label matching, response-time preservation on interrupted submissions, and CSV records. Solo Phase 2 tests cover both roles and conditions from a direct local HTML file using explicitly marked Phase 1 test fixtures. Startup-only tests stub the phases so intake/saving checks stay focused. The plan tests use the actual CSV to check image/label selection; Phase 2 rule tests check matching, feedback, attempt limits, and actual Phase 1 linkage. Test overrides do not alter normal experiment durations.
