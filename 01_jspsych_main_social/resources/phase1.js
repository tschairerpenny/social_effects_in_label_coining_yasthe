/* Phase 1: one shared trial plan, then generation -> discussion -> choice -> joint reveal.
   Research settings are in experiment_config.js; all server traffic stays in PairSync. */
var Phase1 = {
    createRunID: function () {
        // getRandomValues also works on a lab's HTTP LAN server, unlike randomUUID().
        var bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        var hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    },

    parseCSV: function (text) {
        var records = [], record = [], field = '', quoted = false;
        text = text.replace(/^\uFEFF/, '');
        for (var i = 0; i <= text.length; i++) {
            var ch = text[i];
            if (ch === '"') {
                if (quoted && text[i + 1] === '"') { field += '"'; i++; }
                else quoted = !quoted;
            } else if (!quoted && (ch === ',' || ch === '\n' || ch === undefined)) {
                record.push(field.replace(/\r$/, '')); field = '';
                if (ch !== ',') {
                    if (record.some(function (value) { return value !== ''; })) records.push(record);
                    record = [];
                }
            } else field += ch;
        }
        if (quoted || records.length < 2) throw new Error('Invalid or empty stimulus CSV.');
        var headers = records.shift();
        return records.map(function (values) {
            if (values.length !== headers.length) throw new Error('Invalid stimulus CSV row.');
            return Object.fromEntries(headers.map(function (header, index) { return [header, values[index]]; }));
        });
    },

    shuffle: function (values, random) {
        var result = values.slice();
        for (var i = result.length - 1; i > 0; i--) {
            var j = Math.floor(random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
    },

    strategy: function (condition, filler) {
        var assertive = condition === 'assertive';
        return (filler ? !assertive : assertive) ? 'assertive' : 'compliant';
    },

    makePlan: function (rows, condition, random) {
        random = random || Math.random;
        var count = CONFIG.n_concepts, fillers = CONFIG.phase1.n_fillers;
        if (!Number.isInteger(count) || count < 1 || count > rows.length ||
            !Number.isInteger(fillers) || fillers < 0 || fillers > count) {
            throw new Error('Check the Phase 1 trial/filler counts in experiment_config.js.');
        }
        if (!CONFIG.conditions.includes(condition)) throw new Error('Unknown Phase 1 condition.');
        var qualities;
        if (CONFIG.phase1.label_policy === 'balanced') {
            if (count % 2 !== 0) throw new Error('Balanced good/bad labels require an even trial count.');
            qualities = this.shuffle(Array(count / 2).fill('good').concat(Array(count / 2).fill('bad')), random);
        } else if (/^(good|bad)[1-4]$/.test(CONFIG.phase1.label_policy)) {
            qualities = Array(count).fill(CONFIG.phase1.label_policy.slice(0, -1));
        } else throw new Error('Unknown Phase 1 label policy.');
        var slots = {};
        ['good', 'bad'].forEach(function (quality) {
            slots[quality] = Phase1.shuffle(qualities.filter(function (q) { return q === quality; })
                .map(function (_, index) { return quality + (index % 4 + 1); }), random);
        });
        var fillerIndices = new Set(this.shuffle(Array.from({ length: count }, function (_, i) { return i; }), random).slice(0, fillers));
        var positions = this.shuffle(Array.from({ length: count }, function (_, i) { return i % 2; }), random);
        var selected = this.shuffle(rows, random).slice(0, count);
        var plan = {
            version: 1,
            run_id: this.createRunID(),
            condition: condition,
            source: CONFIG.stimuli_file,
            timing: {
                entry_ms: CONFIG.timing.phase1_label_entry_ms,
                discussion_ms: CONFIG.timing.phase1_discussion_ms,
                lead_ms: CONFIG.timing.phase1_sync_lead_ms,
            },
            trials: selected.map(function (row, index) {
                var quality = qualities[index];
                var slot = CONFIG.phase1.label_policy === 'balanced' ? slots[quality].pop() : CONFIG.phase1.label_policy;
                return {
                    trial: index + 1,
                    concept_id: row.concept_id,
                    image: row.image,
                    confederate_label: row[slot],
                    label_slot: slot,
                    label_quality: quality,
                    is_filler: fillerIndices.has(index),
                    strategy: Phase1.strategy(condition, fillerIndices.has(index)),
                    choice_order: positions[index] ? ['confederate', 'naive'] : ['naive', 'confederate'],
                };
            }),
        };
        this.validatePlan(plan, rows, condition);
        return plan;
    },

    validatePlan: function (plan, rows, condition) {
        if (!plan || plan.version !== 1 || typeof plan.run_id !== 'string' || !/^[a-f0-9-]{36}$/.test(plan.run_id) ||
            plan.condition !== condition || !Array.isArray(plan.trials) || plan.trials.length !== CONFIG.n_concepts) {
            throw new Error('Invalid Phase 1 plan or different configurations on the two computers.');
        }
        var timing = plan.timing;
        if (!timing || !Number.isFinite(timing.entry_ms) || timing.entry_ms <= 0 ||
            !Number.isFinite(timing.discussion_ms) || timing.discussion_ms < 0 ||
            !Number.isInteger(timing.lead_ms) || timing.lead_ms < 0 || timing.lead_ms > 5000) {
            throw new Error('Invalid Phase 1 timing.');
        }
        var ids = new Set(), images = new Set();
        plan.trials.forEach(function (item, index) {
            var row = rows.find(function (candidate) { return candidate.concept_id === item.concept_id; });
            if (!row || item.trial !== index + 1 || item.image !== row.image || !/^[\w-]+\.(jpg|jpeg|png)$/i.test(item.image) ||
                !/^(good|bad)[1-4]$/.test(item.label_slot) || !item.confederate_label || item.confederate_label !== row[item.label_slot] ||
                item.label_quality !== item.label_slot.slice(0, -1) || typeof item.is_filler !== 'boolean' ||
                item.strategy !== Phase1.strategy(condition, item.is_filler) ||
                !Array.isArray(item.choice_order) || item.choice_order.slice().sort().join(',') !== 'confederate,naive' ||
                ids.has(item.concept_id) || images.has(item.image)) {
                throw new Error('Invalid or duplicated stimulus in the shared Phase 1 plan.');
            }
            ids.add(item.concept_id); images.add(item.image);
        });
    },

    loadStimuli: async function (settings) {
        if (location.protocol === 'file:') {
            if (!settings.testMode || !settings.solo) {
                throw new Error('Real sessions and two-browser tests require a PHP server. Open the experiment through HTTP or HTTPS.');
            }
            if (typeof LOCAL_STIMULI === 'undefined' || LOCAL_STIMULI.source !== CONFIG.stimuli_file || typeof LOCAL_STIMULI.csv !== 'string') {
                throw new Error('Local preview data is unavailable. Run python tools/build_local_stimuli.py from the experiment folder, then reload the page.');
            }
            return this.parseCSV(LOCAL_STIMULI.csv);
        }
        var response;
        try {
            response = await fetch(CONFIG.stimuli_file, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        } catch (error) {
            throw new Error('Cannot load ' + CONFIG.stimuli_file + '. Check the server connection and that the stimuli folder was uploaded, then try again.');
        }
        if (!response.ok) throw new Error('Cannot load ' + CONFIG.stimuli_file + ' (HTTP ' + response.status + '). Check that the stimuli folder was uploaded.');
        return this.parseCSV(await response.text());
    },

    prepare: async function (settings, condition) {
        var rows = await this.loadStimuli(settings);
        var plan;
        if (settings.testMode && settings.navigation) {
            plan = settings.navigation.plan;
        } else if (settings.solo || settings.role === 'naive') {
            plan = this.makePlan(rows, condition);
            if (!settings.solo) await PairSync.sendValue('phase1_plan', plan);
        } else plan = await PairSync.getPartnerValue('phase1_plan');
        this.validatePlan(plan, rows, condition);
        await Promise.all(plan.trials.map(function (item) {
            return new Promise(function (resolve, reject) {
                var picture = new Image();
                var timer = setTimeout(function () { reject(new Error('Image loading timed out: ' + item.image)); }, 120000);
                picture.onload = function () { clearTimeout(timer); resolve(); };
                picture.onerror = function () { clearTimeout(timer); reject(new Error('Cannot load stimulus image: ' + item.image)); };
                picture.src = 'stimuli/pictures/' + item.image;
            });
        }));
        if (settings.solo) {
            var fallback = PairSync.simulatePartner;
            PairSync.simulatePartner = function (key, context) {
                return Phase1.simulatePartner(plan, key, context, fallback);
            };
        }
        return new Phase1Controller(plan, settings.role);
    },

    simulatePartner: function (plan, key, context, fallback) {
        var match = key.match(new RegExp('^phase1_' + plan.run_id + '_t(\\d+)_(label|choice)$'));
        if (!match) return fallback(key, context);
        var item = plan.trials[Number(match[1]) - 1];
        var other = context.role === 'naive' ? 'confederate' : 'naive';
        var partnerLabel = other === 'confederate' ? item.confederate_label : 'Testbegriff ' + item.concept_id;
        if (match[2] === 'label') return { label: partnerLabel, rt: 500, elapsed_ms: 500, timed_out: false };
        var own = context.ownValues[key.replace(/_choice$/, '_label')];
        var source = other === 'confederate' ? (item.strategy === 'assertive' ? 'confederate' : 'naive') : 'naive';
        var labels = { [context.role]: own.label, [other]: partnerLabel };
        if (!labels[source]) source = 'confederate';
        return { source: source, label: labels[source], rt: 500 };
    },
};

class Phase1Controller {
    constructor(plan, role) {
        this.plan = plan;
        this.role = role;
        this.german = role === 'naive';
        this.results = []; // retained for phases 2/3 as well as the jsPsych CSV
    }

    text(german, english) { return this.german ? german : english; }

    timeline() {
        var controller = this;
        class Phase1Trial {
            constructor(jsPsych) { this.jsPsych = jsPsych; }
            trial(display, trial) {
                controller.runTrial(display, controller.plan.trials[trial.index]).then(data => this.jsPsych.finishTrial(data));
            }
        }
        Phase1Trial.info = { name: 'social-phase1', parameters: { index: { type: jsPsychModule.ParameterType.INT, default: 0 } } };
        return [{
            type: jsPsychHtmlButtonResponse,
            stimulus: this.german ?
                '<div class="phase1-instructions"><h2>Teil 1: Gemeinsame Begriffsfindung</h2>' +
                '<p>Sie sehen beide dasselbe Bild. Überlegen Sie sich unabhängig voneinander einen Begriff, der das Bild möglichst gut beschreibt, und geben Sie ihn ein. Neue Wörter sind erlaubt.</p>' +
                '<p>Sie haben dafür bis zu zwei Minuten Zeit. Sprechen Sie währenddessen noch nicht miteinander.</p>' +
                '<p>Sobald Sie beide fertig sind, werden Ihnen beide Begriffe angezeigt. Sie haben dann eine Minute Zeit, sich darüber auszutauschen und zu versuchen, sich auf einen Begriff zu einigen.</p>' +
                '<p>Danach wählen Sie ohne weiteres Gespräch für sich den Begriff aus, den Sie persönlich bevorzugen. Sobald beide gewählt haben, werden die Entscheidungen aufgedeckt.</p>' +
                '<p>Dies wiederholt sich für ' + this.plan.trials.length + ' Bilder.</p></div>' :
                '<div class="phase1-instructions"><h2>Phase 1: Confederate instructions</h2>' +
                '<p>Use the preselected label shown on your screen. Submit it within two minutes; do not discuss the picture yet.</p>' +
                '<p>Once both labels are visible, discuss them for one minute. Follow the strategy shown for the current trial: Assertive means advocate and select your own label; Compliant means support and select the participant’s label.</p>' +
                '<p>On filler trials the strategy is reversed. The screen always shows the strategy you should use now. It is not shown to the participant.</p>' +
                '<p>After discussion, make the indicated choice. Both decisions are revealed only after both people have responded.</p></div>',
            choices: [this.text('Teil 1 starten', 'Begin Phase 1')],
            data: { phase: 'phase1_instructions' },
        }].concat(this.plan.trials.map(function (_, index) { return { type: Phase1Trial, index: index }; }));
    }

    screen(display, item, stage, heading, showLabels, labels) {
        display.innerHTML = '<section class="phase1-stage"><p class="phase1-counter"></p><h2></h2>' +
            '<img class="phase1-image" alt=""><div class="phase1-guidance"></div>' +
            '<div class="phase1-labels"></div><div class="phase1-controls"></div></section>';
        var root = display.querySelector('section');
        root.dataset.stage = stage;
        root.dataset.trial = item.trial;
        root.querySelector('.phase1-counter').textContent = this.text('Bild ', 'Picture ') + item.trial + ' / ' + this.plan.trials.length;
        root.querySelector('h2').textContent = heading;
        root.querySelector('img').src = 'stimuli/pictures/' + item.image;
        root.querySelector('img').alt = this.text('Bild für die Begriffsfindung', 'Picture for label generation');
        // Before a synchronized generation/reveal, neither side sees the next image or label early.
        if (stage === 'waiting' && !showLabels) root.querySelector('img').hidden = true;
        if (!this.german && !(stage === 'waiting' && !showLabels)) {
            var guidance = root.querySelector('.phase1-guidance');
            var label = document.createElement('p');
            label.textContent = 'Assigned label: ' + item.confederate_label;
            var strategy = document.createElement('p');
            strategy.textContent = 'Current strategy: ' + (item.strategy === 'assertive' ?
                'Assertive — advocate and choose your own label.' : 'Compliant — support and choose the participant’s label.') +
                (item.is_filler ? ' Filler trial: strategy reversed.' : '');
            guidance.append(label, strategy);
        }
        if (showLabels) {
            var box = root.querySelector('.phase1-labels');
            ['naive', 'confederate'].forEach(source => {
                var paragraph = document.createElement('p');
                paragraph.dataset.source = source;
                var name = source === this.role ? this.text('Ihr Begriff: ', 'Your label: ') : this.text('Begriff der anderen Person: ', 'Participant’s label: ');
                paragraph.textContent = name + (labels[source] || this.text('(keine Eingabe)', '(no response)'));
                box.appendChild(paragraph);
            });
        }
        return root.querySelector('.phase1-controls');
    }

    async retry(display, operation) {
        while (true) {
            try { return await operation(); }
            catch (error) {
                var box = display.querySelector('.phase1-controls');
                box.innerHTML = '<p role="alert"></p><button class="jspsych-btn" type="button"></button>';
                box.querySelector('p').textContent = this.text('Verbindungsproblem. Bitte informieren Sie die Versuchsleitung.', 'Connection problem. Please check the partner computer. ' + error.message);
                var button = box.querySelector('button');
                button.textContent = this.text('Erneut versuchen', 'Try again');
                await new Promise(resolve => button.addEventListener('click', resolve, { once: true }));
                box.textContent = this.text('Bitte warten …', 'Please wait …');
            }
        }
    }

    async sync(display, item, step) {
        return this.retry(display, () => PairSync.synchronize('phase1_' + this.plan.run_id + '_t' + item.trial + '_' + step, this.plan.timing.lead_ms));
    }

    generate(display, item) {
        var controls = this.screen(display, item, 'generation', this.text('Begriff eingeben', 'Enter a label'), false);
        controls.innerHTML = '<p class="phase1-timer" role="timer"></p><form autocomplete="off">' +
            '<label for="phase1-label"></label><input id="phase1-label" name="label" type="text" required>' +
            '<button class="jspsych-btn" type="submit"></button></form><p class="phase1-entry-note"></p>';
        var input = controls.querySelector('input');
        input.maxLength = CONFIG.phase1.max_label_length;
        input.readOnly = !this.german;
        if (!this.german) input.value = item.confederate_label;
        controls.querySelector('label').textContent = this.text('Ihr Begriff:', 'Your label (preselected):');
        controls.querySelector('button').textContent = this.text('Begriff abgeben', 'Submit label');
        controls.querySelector('.phase1-entry-note').textContent = this.text('Bitte sprechen Sie noch nicht miteinander.', 'Do not discuss the picture yet.');
        var onset = performance.now(), onsetServer = Date.now() + PairSync.clockOffset;
        input.focus();
        return new Promise(resolve => {
            var finished = false, duration = this.plan.timing.entry_ms;
            var update = () => { controls.querySelector('.phase1-timer').textContent = this.text('Verbleibende Zeit: ', 'Time remaining: ') + Math.max(0, Math.ceil((duration - performance.now() + onset) / 1000)) + ' s'; };
            var ticker = setInterval(update, 200);
            var complete = timedOut => {
                if (finished) return;
                finished = true; clearInterval(ticker); clearTimeout(timeout);
                var elapsed = Math.round(performance.now() - onset);
                resolve({ label: input.value.trim() || null, rt: timedOut ? null : elapsed,
                    elapsed_ms: elapsed, timed_out: timedOut, onset_server_ms: onsetServer });
            };
            var timeout = setTimeout(() => complete(true), duration);
            update();
            controls.querySelector('form').addEventListener('submit', event => {
                event.preventDefault();
                if (performance.now() - onset >= duration) { complete(true); return; }
                input.setCustomValidity(input.value.trim() ? '' : this.text('Bitte geben Sie einen Begriff ein.', 'Please enter a label.'));
                if (input.reportValidity()) complete(false);
            });
            input.addEventListener('input', () => input.setCustomValidity(''));
        });
    }

    async discuss(display, item, labels) {
        var controls = this.screen(display, item, 'discussion', this.text('Begriffe besprechen', 'Discuss the labels'), true, labels);
        var timer = document.createElement('p'); timer.setAttribute('role', 'timer'); controls.appendChild(timer);
        var start = performance.now(), duration = this.plan.timing.discussion_ms;
        var update = () => { timer.textContent = this.text('Sie können jetzt miteinander sprechen. Verbleibende Zeit: ', 'You may discuss now. Time remaining: ') + Math.max(0, Math.ceil((duration - performance.now() + start) / 1000)) + ' s'; };
        update();
        var ticker = setInterval(update, 200);
        await new Promise(resolve => setTimeout(resolve, duration));
        clearInterval(ticker);
        return Math.round(performance.now() - start);
    }

    choose(display, item, labels) {
        var controls = this.screen(display, item, 'choice', this.text('Welchen Begriff bevorzugen Sie?', 'Choose the indicated label'), true, labels);
        var note = document.createElement('p');
        note.textContent = this.text('Bitte sprechen Sie jetzt nicht mehr miteinander. Entscheiden Sie für sich.', 'Do not discuss now. Follow the strategy shown above.');
        controls.appendChild(note);
        var expected = item.strategy === 'assertive' ? 'confederate' : 'naive';
        if (!labels[expected]) expected = 'confederate';
        if (!this.german && !labels.naive) {
            note.textContent = 'The participant did not enter a label. Select your own label for this trial.';
        }
        var onset = performance.now();
        return new Promise(resolve => item.choice_order.forEach(source => {
            var button = document.createElement('button');
            button.type = 'button'; button.className = 'jspsych-btn'; button.dataset.source = source;
            button.textContent = (labels[source] || this.text('(keine Eingabe)', '(no response)')) + ' — ' +
                (source === this.role ? this.text('Ihr Begriff', 'your label') : this.text('Begriff der anderen Person', 'participant’s label'));
            button.disabled = !labels[source] || (!this.german && source !== expected);
            button.addEventListener('click', () => resolve({ label: labels[source], source: source, rt: Math.round(performance.now() - onset) }), { once: true });
            controls.appendChild(button);
        }));
    }

    async runTrial(display, item) {
        var key = 'phase1_' + this.plan.run_id + '_t' + item.trial;
        this.screen(display, item, 'waiting', this.text('Bitte warten Sie auf die andere Person.', 'Waiting for the participant.'), false);
        var generationSchedule = await this.sync(display, item, 'generation');
        var own = await this.generate(display, item);
        this.screen(display, item, 'waiting', this.text('Ihr Begriff wurde erfasst. Bitte warten Sie auf die andere Person.', 'Label recorded. Waiting for the participant.'), false);
        await this.retry(display, () => PairSync.sendValue(key + '_label', own));
        var partner = await this.retry(display, () => PairSync.getPartnerValue(key + '_label'));
        var entries = { [this.role]: own, [this.german ? 'confederate' : 'naive']: partner };
        var labels = { naive: entries.naive.label, confederate: entries.confederate.label };
        var discussionSchedule = await this.sync(display, item, 'discussion');
        var discussionElapsed = await this.discuss(display, item, labels);
        this.screen(display, item, 'waiting', this.text('Die Gesprächszeit ist vorbei. Bitte sprechen Sie nicht weiter.', 'Discussion is over. Please stop talking.'), true, labels);
        await this.sync(display, item, 'choice');
        var choice = await this.choose(display, item, labels);
        this.screen(display, item, 'waiting', this.text('Ihre Wahl wurde erfasst. Bitte warten Sie auf die andere Person.', 'Choice recorded. Waiting for the participant.'), true, labels);
        await this.retry(display, () => PairSync.sendValue(key + '_choice', choice));
        var partnerChoice = await this.retry(display, () => PairSync.getPartnerValue(key + '_choice'));
        var choices = { [this.role]: choice, [this.german ? 'confederate' : 'naive']: partnerChoice };
        var revealSchedule = await this.sync(display, item, 'reveal');
        var controls = this.screen(display, item, 'reveal', this.text('Ihre Entscheidungen', 'Both decisions'), true, labels);
        ['naive', 'confederate'].forEach(source => {
            var paragraph = document.createElement('p'); paragraph.dataset.choiceSource = source;
            paragraph.textContent = (source === this.role ? this.text('Ihre Wahl: ', 'Your choice: ') : this.text('Wahl der anderen Person: ', 'Participant’s choice: ')) + choices[source].label;
            controls.appendChild(paragraph);
        });
        var button = document.createElement('button'); button.type = 'button'; button.className = 'jspsych-btn';
        button.textContent = this.text('Weiter', 'Continue'); controls.appendChild(button);
        await new Promise(resolve => button.addEventListener('click', resolve, { once: true }));
        var data = {
            phase: 'phase1', trial: item.trial, concept_id: item.concept_id, stimulus: item.image,
            phase1_run_id: this.plan.run_id, label_slot: item.label_slot, label_quality: item.label_quality,
            is_filler: item.is_filler, confederate_strategy: item.strategy, confederate_assigned_label: item.confederate_label,
            own_label: own.label, partner_label: partner.label, participant_label: labels.naive, confederate_label: labels.confederate,
            label_rt: own.rt, rt: own.rt, label_timed_out: own.timed_out, label_elapsed_ms: own.elapsed_ms,
            participant_label_rt: entries.naive.rt, participant_label_timed_out: entries.naive.timed_out,
            confederate_label_rt: entries.confederate.rt, confederate_label_timed_out: entries.confederate.timed_out,
            response: choice.label, choice_source: choice.source, choice_rt: choice.rt,
            participant_choice: choices.naive.label, participant_choice_source: choices.naive.source, participant_choice_rt: choices.naive.rt,
            confederate_choice: choices.confederate.label, confederate_choice_source: choices.confederate.source,
            choice_order: item.choice_order, labels_identical: labels.naive === labels.confederate,
            choice_matches_confederate_label: choices.naive.label === labels.confederate,
            strategy_fallback: !labels.naive ? 'missing_participant_label' : null,
            generation_scheduled_server_ms: generationSchedule.scheduled_server_time_ms,
            generation_onset_server_ms: own.onset_server_ms,
            discussion_scheduled_server_ms: discussionSchedule.scheduled_server_time_ms, discussion_elapsed_ms: discussionElapsed,
            reveal_scheduled_server_ms: revealSchedule.scheduled_server_time_ms,
        };
        this.results.push(data);
        return data;
    }
}
