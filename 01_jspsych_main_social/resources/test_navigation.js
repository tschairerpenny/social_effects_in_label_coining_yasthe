/* Test-only phase previews. Reloading cancels the old trial's timers and pending callbacks. */
var TestNavigation = {
    storageKey: 'social-test-navigation',
    phases: ['intake', 'phase1', 'phase2', 'finish'],

    takePending: function () {
        try {
            var value = sessionStorage.getItem(this.storageKey);
            sessionStorage.removeItem(this.storageKey);
            var settings = value && JSON.parse(value);
            if (settings && settings.testMode === true && settings.navigation &&
                this.phases.includes(settings.navigation.phase) && /^test-[a-f0-9]{16}$/.test(settings.navigation.sessionID)) {
                return settings;
            }
        } catch (error) {
            // Normal setup remains available when browser storage is unavailable.
        }
        return null;
    },

    seedPhase1: function (phase1) {
        phase1.results = phase1.plan.trials.map(function (item) {
            return {
                phase1_run_id: phase1.plan.run_id,
                trial: item.trial,
                concept_id: item.concept_id,
                stimulus: item.image,
                participant_label: 'Testbegriff ' + item.concept_id,
                confederate_label: item.confederate_label,
                phase1_test_fixture: true,
            };
        });
    },

    mount: function (root, settings, phase1) {
        if (!settings.testMode) return;
        root.hidden = false;
        root.innerHTML = '<details><summary>Test: jump to phase</summary>' +
            '<label for="test-phase-select">Start at:</label> ' +
            '<select id="test-phase-select">' +
            (settings.role === 'naive' ? '<option value="intake">Consent &amp; demographics</option>' : '') +
            '<option value="phase1">Phase 1</option><option value="phase2">Phase 2</option>' +
            '<option value="finish">Finish / CSV download</option></select> ' +
            '<button type="button">Go</button>' +
            '<small>Starts a fresh preview and clears current test responses. Phase 2 uses simulated Phase 1 labels.' +
            (settings.solo ? '' : ' Select the same phase on both computers.') + '</small>' +
            '<p role="status"></p></details>';
        var select = root.querySelector('select');
        var button = root.querySelector('button');
        var status = root.querySelector('[role="status"]');
        select.value = settings.navigation ? settings.navigation.phase : 'phase1';
        button.addEventListener('click', async function () {
            button.disabled = true;
            select.disabled = true;
            try {
                // Check storage before coordinating a paired jump.
                sessionStorage.setItem(TestNavigation.storageKey, 'null');
                sessionStorage.removeItem(TestNavigation.storageKey);
                var plan = Object.assign({}, phase1.plan, { run_id: Phase1.createRunID() });
                if (!settings.solo) {
                    var previous = PairSync.values && PairSync.values.test_navigation;
                    if (previous && previous.phase === select.value && previous.from_run_id === phase1.plan.run_id && previous.plan) {
                        plan = previous.plan; // A retry must keep the plan the other browser may already have accepted.
                    }
                    status.textContent = 'Waiting: select the same phase on the other computer, then click Go.';
                    await PairSync.sendValue('test_navigation', {
                        phase: select.value, from_run_id: phase1.plan.run_id,
                        plan: settings.role === 'naive' ? plan : null,
                    });
                    var partner = settings.role === 'naive' ? 'confederate' : 'naive';
                    var deadline = Date.now() + 60000;
                    while (true) {
                        var state = await PairSync.request('get');
                        var entry = state[partner].test_navigation;
                        var request = entry && entry.value;
                        if (request && request.phase === select.value && request.from_run_id === phase1.plan.run_id) {
                            if (settings.role === 'confederate') plan = request.plan;
                            break;
                        }
                        if (Date.now() >= deadline) throw new Error('The other computer did not select this phase. Select the same phase on both computers and try again.');
                        await new Promise(function (resolve) { setTimeout(resolve, CONFIG.timing.sync_poll_interval_ms); });
                    }
                }
                var nextSettings = Object.assign({}, settings, {
                    condition: phase1.plan.condition,
                    navigation: { phase: select.value, sessionID: PairSync.pairID, plan: plan },
                });
                sessionStorage.setItem(TestNavigation.storageKey, JSON.stringify(nextSettings));
                location.reload();
            } catch (error) {
                status.textContent = 'Could not jump: ' + error.message;
                button.disabled = false;
                select.disabled = false;
            }
        });
    },
};
