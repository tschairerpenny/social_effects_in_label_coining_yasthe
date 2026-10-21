# Main experiment: social influence on label adoption

Two participants (a naive participant and a confederate) sit at two computers in the lab and take part in the same session. Startup screens, solo-test simulation, and browser synchronization are implemented. The main experimental phases are still a skeleton; real ID management, server saving, and consent resources still need to be copied/adapted from the Exp2 pre-study (see below).

## Folder structure

| Path | Content | Status |
|---|---|---|
| `main_social.html` | The experiment (jsPsych 7.2.3). Startup and test saving are implemented; real ID/consent/saving need the infrastructure below. Main experimental phases remain `TODO`. | partly implemented |
| `resources/experiment_config.js` | All changeable parameters: conditions, timing, trial numbers, confederate behaviour, stimuli file. | to fill in |
| `resources/experiment_setup.js` | Experimenter-only run type, role, condition, and session entry screens. | implemented |
| `resources/pair_sync.js` | Browser communication, partner waiting, and local solo-test simulation. | implemented |
| `sync/sync.php` | Locked shared store of both participants' responses and session condition (PHP 7.3+). | implemented |
| `stimuli/concepts.csv` | 20 concepts from Exp2, one row each: `concept_nr`, `concept_id`, `image`, `good1`-`good4`, `bad1`-`bad4` (ordered by SigLIP2 cosine), `labels_to_check`. Read by the experiment. | done (provisional) |
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

Experimenter-only screens, test controls, and confederate screens are in English. Participant-facing instructions, consent, demographics, and required-answer messages remain in German. Conditions are displayed as **Assertive** and **Compliant**; existing stored codes remain `consistent` and `accommodating`, respectively, to keep data and saved sessions compatible.

For a **real session**, prepare the participant's computer first. It obtains a pair ID from `ID_management/IDs_social.txt` and displays it. On the second computer select real data collection and Confederate, and enter that ID in the form. The condition still follows from the pair ID (`getCondition()`). Only the real participant's browser calls ID cleanup, after data saving succeeds. Failed startup/saving requests display an error instead of silently advancing. Real participant runs require the consent form and the PHP infrastructure above. The confederate neither loads nor sees the consent form and skips demographics.

For a **solo test**, select Test run and **Test alone (simulate partner)**, choose either role and a condition. A fresh temporary `test-...` session code is generated. No ID allocation, ID cleanup, synchronization, or server-saving requests are made. For participants, a missing consent form is replaced by an explicitly marked test placeholder; the German demographics survey follows consent in both test and real runs. Confederates skip both screens. The final screen offers a `TEST_social_<session>_<role>_<timestamp>.csv` download. A banner identifies the test throughout the run.

For a **two-browser test**, serve the folder through the same PHP server on both computers. On the first select Test run, Participant, **Test with two browsers**, and a condition. On the second select Test run, Confederate, **Test with two browsers**, and enter the first computer's temporary session code. The confederate automatically inherits the condition. Sync files go exclusively to `sync/state_test/`; ID management and server data saving remain disabled. Start each fresh test from a new participant setup to avoid reusing old partner responses.

Every data row contains `pair_id` (null in tests), `session_id`, `role`, `condition`, `test_mode`, and `connection_mode` (`solo` or `paired`). Real data filenames remain `data/social_<pair>_<role>_<timestamp>.csv`; merge the two files by `pair_id` in the analysis.

**Scope of testing:** the current timeline still has TODOs for phases 1-3 and the questionnaire. Startup does not implement those tasks. Solo fixtures in `CONFIG.testing.partnerValue` supply phase-1 test labels/choices and can echo values already sent under other keys. Add task-specific fixtures as the remaining message keys and response formats are defined; unknown keys fail explicitly. Simulated responses are only for checking program flow.

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

**Why PHP with polling instead of WebSockets, Firebase or Supabase:**

- It runs on the HU server we already use for the pre-studies, with the same upload workflow. Participants need nothing but a normal browser.
- WebSockets need a server program (e.g. Node.js) that runs permanently, which normal PHP web hosting does not allow.
- Firebase and Supabase store the data with an external (US) company. That causes data-protection problems and requires changing the consent form.
- With two participants and a few exchanges per minute, a 0.5 s delay is not noticeable in the lab, so real-time push is not needed.

**Separation of logic.** `main_social.html` contains only the experimental logic and calls only the four `PairSync` functions. `pair_sync.js` and `sync.php` contain only the communication. All parameters live in `experiment_config.js`. Changing concepts, timing, trial numbers or confederate behaviour should never require touching the sync code.

## Before the first real session

- Create the folders `data/`, `sync/state/` and `sync/state_test/` on the server and make them writable, as for the pre-studies. Test CSVs are downloaded locally.
- Set the number of IDs in `ID_management/IDs_social.txt` to the planned number of pairs.
- Complete the experimental phase TODOs and adapt the consent form.
- Run at least one full test session on the two real lab computers.

## Startup regression tests

`tests/startup.test.cjs` uses Node.js (22+), Playwright, an installed Edge browser, and PHP (7.3+). It runs against a temporary copy, with fixture consent/ID/save scripts; it does not touch research IDs or data. Install Playwright in your test environment, put `php` on PATH (or set `PHP_BINARY` to its executable), then run from this folder:

```powershell
node --test tests/startup.test.cjs
```

Set `BROWSER_CHANNEL` to use another installed Playwright browser channel. The tests download the page's exact pinned CDN scripts once, so they require internet access. They check English setup/condition labels, German participant demographics and required responses, participant-only consent/demographics in test and real runs, test isolation, local CSVs, paired condition/message exchange, missing infrastructure, invalid IDs, and saving/cleanup failures.
