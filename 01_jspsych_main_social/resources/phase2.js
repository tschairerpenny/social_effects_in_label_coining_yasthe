/* Phase 2: participant sends a label; confederate gives scripted image-selection feedback.
   Reuses Phase 1 pictures, order, filler flags, and actual confederate labels.
   Each submitted attempt is a separate jsPsych row. Server traffic stays in PairSync. */
var Phase2 = {
    normalizeLabel: function (label) {
        return label.normalize('NFC').trim().toLocaleLowerCase('de-DE');
    },

    labelsMatch: function (label, reference) {
        return typeof label === 'string' && typeof reference === 'string' &&
            this.normalizeLabel(label) !== '' && this.normalizeLabel(label) === this.normalizeLabel(reference);
    },

    requiredFeedback: function (strategy, label, reference) {
        if (strategy !== 'assertive' && strategy !== 'compliant') throw new Error('Unknown Phase 2 strategy.');
        return strategy === 'compliant' || this.labelsMatch(label, reference);
    },

    pictureComplete: function (correct, attempt, maximum) {
        return correct || attempt >= maximum;
    },

    prepare: async function (phase1, settings) {
        if (!phase1.plan || settings.role !== phase1.role) throw new Error('Phase 2 requires the shared Phase 1 plan and matching role.');
        var key = 'phase2_' + phase1.plan.run_id + '_plan';
        var plan;
        if (settings.solo || settings.role === 'naive') {
            plan = {
                phase1_run_id: phase1.plan.run_id,
                max_attempts: CONFIG.phase2.max_attempts,
                max_label_length: CONFIG.phase2.max_label_length,
                feedback_ms: CONFIG.timing.phase2_feedback_ms,
                lead_ms: CONFIG.timing.phase2_sync_lead_ms,
            };
            if (!settings.solo) await PairSync.sendValue(key, plan);
        } else plan = await PairSync.getPartnerValue(key);
        if (!plan || plan.phase1_run_id !== phase1.plan.run_id || !Number.isInteger(plan.max_attempts) ||
            plan.max_attempts < 1 || plan.max_attempts > 3 || !Number.isInteger(plan.max_label_length) || plan.max_label_length < 1 ||
            !Number.isFinite(plan.feedback_ms) || plan.feedback_ms < 0 || !Number.isInteger(plan.lead_ms) || plan.lead_ms < 0 || plan.lead_ms > 5000) {
            throw new Error('Invalid Phase 2 settings. Set one to three attempts and valid timing in experiment_config.js.');
        }
        return new Phase2Controller(phase1, settings.role, plan);
    },

    validateLabel: function (entry) {
        if (!entry || typeof entry.label !== 'string' || !entry.label.trim() || typeof entry.raw_label !== 'string' ||
            entry.raw_label.trim() !== entry.label || !Number.isFinite(entry.rt) || entry.rt < 0) {
            throw new Error('Invalid Phase 2 label response.');
        }
        return entry;
    },

    validateFeedback: function (feedback, expected) {
        if (!feedback || typeof feedback.correct !== 'boolean' || feedback.correct !== expected ||
            !Number.isFinite(feedback.rt) || feedback.rt < 0) {
            throw new Error('Partner feedback does not match this trial’s Phase 2 strategy. Please check both computers.');
        }
        return feedback;
    },
};

class Phase2Controller {
    constructor(phase1, role, plan) {
        this.phase1 = phase1;
        this.plan = plan;
        this.role = role;
        this.german = role === 'naive';
        this.completed = new Set();
        this.results = [];
        this.initialized = false;
    }

    text(german, english) { return this.german ? german : english; }

    phase1Record(item) {
        var record = this.phase1.results.find(row => row.concept_id === item.concept_id && row.phase1_run_id === this.plan.phase1_run_id);
        if (!record || record.stimulus !== item.image || typeof record.confederate_label !== 'string' || !record.confederate_label.trim()) {
            throw new Error('Phase 1 responses are missing for Phase 2 concept ' + item.concept_id + '.');
        }
        return record;
    }

    initialize() {
        if (this.initialized) return;
        this.phase1.plan.trials.forEach(item => this.phase1Record(item));
        if (PairSync.solo) {
            var fallback = PairSync.simulatePartner;
            PairSync.simulatePartner = (key, context) => this.simulatePartner(key, context, fallback);
        }
        this.initialized = true;
    }

    simulatePartner(key, context, fallback) {
        var match = key.match(new RegExp('^phase2_' + this.plan.phase1_run_id + '_t(\\d+)_a(\\d+)_(label|feedback)$'));
        if (!match) return fallback(key, context);
        var item = this.phase1.plan.trials[Number(match[1]) - 1];
        var previous = this.phase1Record(item);
        if (match[3] === 'label') {
            // Confederate-only previews get two non-matching labels, then the reference label.
            var label = Number(match[2]) === this.plan.max_attempts ? previous.confederate_label : 'Testbegriff ' + item.concept_id;
            return { label: label, raw_label: label, rt: 500, onset_server_ms: null };
        }
        var entry = context.ownValues[key.replace(/_feedback$/, '_label')];
        return { correct: Phase2.requiredFeedback(item.strategy, entry.label, previous.confederate_label), rt: 500 };
    }

    timeline() {
        var controller = this;
        class Phase2Attempt {
            constructor(jsPsych) { this.jsPsych = jsPsych; }
            trial(display, trial) {
                controller.runAttempt(display, controller.phase1.plan.trials[trial.index], trial.attempt)
                    .then(data => this.jsPsych.finishTrial(data));
            }
        }
        Phase2Attempt.info = { name: 'social-phase2', parameters: {
            index: { type: jsPsychModule.ParameterType.INT, default: 0 },
            attempt: { type: jsPsychModule.ParameterType.INT, default: 1 },
        } };
        var timeline = [{
            type: jsPsychHtmlButtonResponse,
            stimulus: this.german ?
                '<div class="phase2-instructions"><h2>Teil 2: Bilder erkennen</h2>' +
                '<p>Sie sehen jeweils ein einzelnes Bild. Die andere Person sieht mehrere ähnliche Bilder, darunter auch Ihres.</p>' +
                '<p>Geben Sie einen Begriff ein, der Ihr Bild möglichst gut beschreibt, damit die andere Person das richtige Bild auswählen kann.</p>' +
                '<p>Nach jeder Auswahl erfahren Sie, ob das richtige Bild ausgewählt wurde. Für jedes Bild haben Sie maximal ' + this.plan.max_attempts + ' Versuche.</p>' +
                '<p>Bei einer falschen Auswahl können Sie Ihren Begriff verändern oder genauer beschreiben. Bei einer richtigen Auswahl geht es direkt mit dem nächsten Bild weiter.</p></div>' :
                '<div class="phase2-instructions"><h2>Phase 2: Confederate instructions</h2>' +
                '<p>You will see your label from Phase 1, the participant’s newly submitted label, and the current strategy. No picture or picture array is shown on this computer.</p>' +
                '<p>Assertive: select Incorrect until the participant uses your Phase 1 label; then select Correct. Compliant: select Correct immediately, regardless of their label.</p>' +
                '<p>Filler trials reverse the base condition. Follow the current strategy shown on screen. Capitalization and surrounding spaces are ignored when matching labels.</p>' +
                '<p>Only the required feedback button is enabled. A picture ends after Correct or after ' + this.plan.max_attempts + ' unsuccessful attempts.</p></div>',
            choices: [this.text('Teil 2 starten', 'Begin Phase 2')],
            on_start: () => this.initialize(),
            data: { phase: 'phase2_instructions' },
        }];
        this.phase1.plan.trials.forEach((item, index) => {
            for (var attempt = 1; attempt <= this.plan.max_attempts; attempt++) {
                timeline.push({
                    timeline: [{ type: Phase2Attempt, index: index, attempt: attempt }],
                    conditional_function: () => !this.completed.has(item.concept_id),
                });
            }
        });
        return timeline;
    }

    screen(display, item, attempt, stage, heading, entry, revealImage = true) {
        display.innerHTML = '<section class="phase2-stage"><p class="phase2-counter"></p><h2></h2>' +
            '<div class="phase2-picture"></div><div class="phase2-guidance"></div>' +
            '<p class="phase2-submitted-label"></p><div class="phase2-controls"></div></section>';
        var root = display.querySelector('section');
        root.dataset.stage = stage; root.dataset.trial = item.trial; root.dataset.attempt = attempt;
        root.querySelector('h2').textContent = heading;
        root.querySelector('.phase2-counter').textContent = this.text('Bild ', 'Picture ') + item.trial + ' / ' + this.phase1.plan.trials.length +
            this.text(' · Versuch ', ' · Attempt ') + attempt + ' / ' + this.plan.max_attempts;
        if (this.german && revealImage) {
            var image = document.createElement('img'); image.className = 'phase2-image';
            image.src = 'stimuli/pictures/' + item.image; image.alt = 'Bild für die Beschreibung';
            root.querySelector('.phase2-picture').appendChild(image);
        }
        if (!this.german) {
            var previous = this.phase1Record(item);
            var guidance = root.querySelector('.phase2-guidance');
            var label = document.createElement('p'); label.textContent = 'Your Phase 1 label: ' + previous.confederate_label;
            var strategy = document.createElement('p');
            strategy.textContent = 'Current strategy: ' + (item.strategy === 'assertive' ?
                'Assertive — Incorrect until the participant uses your Phase 1 label.' : 'Compliant — Correct immediately.') +
                (item.is_filler ? ' Filler trial: strategy reversed.' : '');
            guidance.append(label, strategy);
        }
        if (entry) root.querySelector('.phase2-submitted-label').textContent =
            this.text('Ihr Begriff: ', 'Participant’s submitted label: ') + entry.label;
        return root.querySelector('.phase2-controls');
    }

    async retry(display, operation) {
        while (true) {
            try { return await operation(); }
            catch (error) {
                var controls = display.querySelector('.phase2-controls');
                controls.innerHTML = '<p role="alert"></p><button type="button" class="jspsych-btn"></button>';
                controls.querySelector('p').textContent = this.text('Verbindungsproblem. Bitte informieren Sie die Versuchsleitung.', 'Connection problem. ' + error.message);
                var button = controls.querySelector('button'); button.textContent = this.text('Erneut versuchen', 'Try again');
                await new Promise(resolve => button.addEventListener('click', resolve, { once: true }));
                controls.textContent = this.text('Bitte warten …', 'Please wait …');
            }
        }
    }

    collectLabel(display, item, attempt) {
        var controls = this.screen(display, item, attempt, 'generation', 'Beschreiben Sie das Bild');
        controls.innerHTML = '<form autocomplete="off"><label for="phase2-label">Ihr Begriff:</label>' +
            '<input id="phase2-label" name="label" type="text" required>' +
            '<button class="jspsych-btn" type="submit">Begriff abgeben</button></form>';
        var input = controls.querySelector('input'); input.maxLength = this.plan.max_label_length;
        var onset = performance.now(), onsetServer = Date.now() + PairSync.clockOffset;
        input.focus();
        return new Promise(resolve => {
            controls.querySelector('form').addEventListener('submit', event => {
                event.preventDefault();
                input.setCustomValidity(input.value.trim() ? '' : 'Bitte geben Sie einen Begriff ein.');
                if (!input.reportValidity()) return;
                resolve({ label: input.value.trim(), raw_label: input.value, rt: Math.round(performance.now() - onset), onset_server_ms: onsetServer });
            });
            input.addEventListener('input', () => input.setCustomValidity(''));
        });
    }

    collectFeedback(display, item, attempt, entry, expected) {
        var controls = this.screen(display, item, attempt, 'judgment', 'Select image feedback', entry);
        var note = document.createElement('p'); note.textContent = 'Required feedback: ' + (expected ? 'Correct' : 'Incorrect'); controls.appendChild(note);
        var onset = performance.now();
        return new Promise(resolve => [true, false].forEach(correct => {
            var button = document.createElement('button'); button.type = 'button'; button.className = 'jspsych-btn';
            button.textContent = correct ? 'Correct' : 'Incorrect'; button.dataset.correct = String(correct); button.disabled = correct !== expected;
            button.addEventListener('click', () => resolve({ correct: correct, rt: Math.round(performance.now() - onset) }), { once: true });
            controls.appendChild(button);
        }));
    }

    async runAttempt(display, item, attempt) {
        var previous = this.phase1Record(item);
        var key = 'phase2_' + this.plan.phase1_run_id + '_t' + item.trial + '_a' + attempt;
        this.screen(display, item, attempt, 'waiting', this.text('Bitte warten Sie auf die andere Person.', 'Waiting for the participant’s label.'), null, false);
        var entrySchedule = await this.retry(display, () => PairSync.synchronize(key + '_entry', this.plan.lead_ms));
        var entry;
        if (this.german) {
            entry = await this.collectLabel(display, item, attempt);
            this.screen(display, item, attempt, 'waiting', 'Ihr Begriff wurde erfasst. Bitte warten Sie auf die Auswahl der anderen Person.', entry);
            await this.retry(display, () => PairSync.sendValue(key + '_label', entry));
        } else entry = await this.retry(display, async () => Phase2.validateLabel(await PairSync.getPartnerValue(key + '_label')));
        var matches = Phase2.labelsMatch(entry.label, previous.confederate_label);
        var expected = Phase2.requiredFeedback(item.strategy, entry.label, previous.confederate_label);
        var feedback;
        if (this.german) {
            feedback = await this.retry(display, async () => Phase2.validateFeedback(await PairSync.getPartnerValue(key + '_feedback'), expected));
        } else {
            feedback = await this.collectFeedback(display, item, attempt, entry, expected);
            this.screen(display, item, attempt, 'waiting', 'Feedback recorded. Waiting for the shared reveal.', entry);
            await this.retry(display, () => PairSync.sendValue(key + '_feedback', feedback));
        }
        var feedbackSchedule = await this.retry(display, () => PairSync.synchronize(key + '_feedback', this.plan.lead_ms));
        var complete = Phase2.pictureComplete(feedback.correct, attempt, this.plan.max_attempts);
        var controls = this.screen(display, item, attempt, 'feedback', this.text('Rückmeldung', 'Feedback'), entry);
        var message = document.createElement('p'); message.className = 'phase2-feedback'; message.dataset.correct = String(feedback.correct);
        message.textContent = feedback.correct ? this.text('Das richtige Bild wurde ausgewählt.', 'Correct image selected.') :
            this.text('Es wurde ein falsches Bild ausgewählt.', 'Incorrect image selected.');
        var next = document.createElement('p');
        next.textContent = complete ? this.text('Es geht mit dem nächsten Bild weiter.', 'Moving on to the next picture.') :
            this.text('Sie können Ihren Begriff im nächsten Versuch verändern.', 'The participant can change their label on the next attempt.');
        controls.append(message, next);
        await new Promise(resolve => setTimeout(resolve, this.plan.feedback_ms));
        await this.retry(display, () => PairSync.synchronize(key + '_complete', 0));
        if (complete) this.completed.add(item.concept_id);
        var data = {
            phase: 'phase2', trial: item.trial, concept_id: item.concept_id, stimulus: item.image,
            phase1_run_id: this.plan.phase1_run_id, phase1_trial: previous.trial,
            phase1_participant_label: previous.participant_label, phase1_confederate_label: previous.confederate_label,
            confederate_label: previous.confederate_label, confederate_assigned_label: previous.confederate_assigned_label,
            label_slot: previous.label_slot, label_quality: previous.label_quality,
            is_filler: item.is_filler, confederate_strategy: item.strategy,
            attempt: attempt, max_attempts: this.plan.max_attempts,
            participant_label: entry.label, participant_label_raw: entry.raw_label,
            participant_label_rt: entry.rt, label_rt: entry.rt, rt: entry.rt, response: entry.label,
            label_matches_confederate: matches, feedback_correct: feedback.correct, expected_feedback_correct: expected, feedback_rt: feedback.rt,
            picture_complete: complete, end_reason: feedback.correct ? 'correct' : (complete ? 'max_attempts' : null),
            attempts_remaining: complete ? 0 : this.plan.max_attempts - attempt,
            generation_scheduled_server_ms: entrySchedule.scheduled_server_time_ms,
            generation_onset_server_ms: entry.onset_server_ms,
            feedback_scheduled_server_ms: feedbackSchedule.scheduled_server_time_ms,
        };
        this.results.push(data);
        return data;
    }
}
