const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = path.resolve(__dirname, '..');

function root() {
    const controls = Object.fromEntries(['select', 'button', '[role="status"]'].map(name => [name, {
        addEventListener(event, listener) { this[event] = listener; },
    }]));
    return { hidden: true, innerHTML: '', querySelector: name => controls[name] };
}

function environment() {
    const storage = new Map();
    const elements = new Map();
    const context = vm.createContext({
        crypto: webcrypto, setTimeout, clearTimeout, AbortSignal,
        location: { protocol: 'file:', reload() { context.reloaded = true; } },
        sessionStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key),
        },
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, root());
            return elements.get(id);
        } },
        Image: class { set src(value) { this.onload(); } },
        jsPsychModule: { ParameterType: { INT: 1 } },
        initJsPsych: () => ({
            data: { addProperties(properties) { Object.assign(context.properties, properties); } },
            run(timeline) { context.timeline = timeline; },
        }),
        ExperimentSetup: { mount() {}, createTestSession: () => 'test-0123456789abcdef' },
        properties: {},
    });
    for (const plugin of ['Survey', 'HtmlButtonResponse', 'HtmlKeyboardResponse', 'ExternalHtml', 'Fullscreen', 'CallFunction']) {
        context['jsPsych' + plugin] = function () {};
    }
    for (const file of ['stimuli/concepts.js', 'resources/experiment_config.js', 'resources/pair_sync.js',
        'resources/phase1.js', 'resources/phase2.js', 'resources/test_navigation.js']) {
        vm.runInContext(fs.readFileSync(path.join(source, file), 'utf8'), context, { filename: file });
    }
    const html = fs.readFileSync(path.join(source, 'main_social.html'), 'utf8');
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context, { filename: 'main_social.html' });
    context.plan = context.Phase1.makePlan(context.Phase1.parseCSV(context.LOCAL_STIMULI.csv), 'assertive');
    return context;
}

function settings(role = 'naive', solo = true) {
    return { testMode: true, role, solo, condition: 'assertive' };
}

test('navigation is hidden in real runs and pending navigation is test-only and consumed once', () => {
    const c = environment();
    const element = root();
    c.TestNavigation.mount(element, { testMode: false });
    assert.equal(element.hidden, true);
    const pending = { ...settings(), navigation: { phase: 'phase2', sessionID: 'test-0123456789abcdef', plan: c.plan } };
    c.sessionStorage.setItem(c.TestNavigation.storageKey, JSON.stringify({ ...pending, testMode: false }));
    assert.equal(c.TestNavigation.takePending(), null);
    c.sessionStorage.setItem(c.TestNavigation.storageKey, JSON.stringify(pending));
    assert.equal(c.TestNavigation.takePending().navigation.phase, 'phase2');
    assert.equal(c.TestNavigation.takePending(), null);
    c.sessionStorage.setItem(c.TestNavigation.storageKey, '{broken JSON');
    assert.equal(c.TestNavigation.takePending(), null);
});

for (const role of ['naive', 'confederate']) {
    test(`solo ${role} can jump directly to Phase 2 with valid labels, then restart Phase 1`, async () => {
        const c = environment();
        c.PairSync.pairID = 'test-0123456789abcdef';
        const element = root();
        c.TestNavigation.mount(element, settings(role), { plan: c.plan });
        assert.equal(element.hidden, false);
        assert.equal(element.innerHTML.includes('Consent &amp; demographics'), role === 'naive');
        element.querySelector('select').value = 'phase2';
        await element.querySelector('button').click();
        assert.equal(c.reloaded, true);
        const pending = c.TestNavigation.takePending();
        assert.notEqual(pending.navigation.plan.run_id, c.plan.run_id);
        assert.equal(pending.navigation.plan.trials[0].image, c.plan.trials[0].image);
        await c.startExperiment(pending);
        assert.equal(c.timeline[0].timeline[0].data.phase, 'phase2_instructions');
        assert.equal(c.properties.phase1_test_fixture, true);
        // The actual Phase 2 initializer validates every seeded record before its first trial.
        c.timeline[0].timeline[0].on_start();
        pending.navigation.phase = 'phase1';
        await c.startExperiment(pending);
        assert.equal(c.timeline[0].timeline[0].data.phase, 'phase1_instructions');
        assert.equal(c.properties.phase1_test_fixture, false);
    });
}

test('intake and finish previews start at their destinations; normal startup retains the full timeline', async () => {
    const c = environment();
    await c.startExperiment(settings());
    assert.equal(c.timeline[0].data.phase, 'setup');
    const pending = { ...settings(), navigation: { phase: 'intake', sessionID: c.PairSync.pairID, plan: c.plan } };
    await c.startExperiment(pending);
    assert.equal(c.timeline[0].timeline[0].data.phase, 'consent_test_placeholder');
    assert.equal(c.timeline[0].timeline[1].data.phase, 'demographics');
    pending.navigation.phase = 'finish';
    await c.startExperiment(pending);
    assert.equal(c.timeline.length, 3);
    assert.equal(c.timeline[0].type, c.jsPsychCallFunction);
});

test('paired navigation agrees on the participant plan and a new run ID, including repeated jumps', async () => {
    const a = environment(), b = environment();
    const state = { naive: {}, confederate: {} };
    const roots = [root(), root()];
    const sharedPlan = a.plan;
    for (const [c, role] of [[a, 'naive'], [b, 'confederate']]) {
        c.CONFIG.timing.sync_poll_interval_ms = 1;
        c.PairSync.pairID = 'test-0123456789abcdef';
        c.PairSync.sendValue = async (key, value) => { state[role][key] = { value }; };
        c.PairSync.request = async () => state;
    }
    let plan = sharedPlan;
    for (const phase of ['phase2', 'phase1', 'phase2']) {
        a.reloaded = b.reloaded = false;
        a.TestNavigation.mount(roots[0], settings('naive', false), { plan });
        b.TestNavigation.mount(roots[1], settings('confederate', false), { plan });
        roots.forEach(element => { element.querySelector('select').value = phase; });
        await Promise.all(roots.map(element => element.querySelector('button').click()));
        assert.equal(a.reloaded, true);
        assert.equal(b.reloaded, true);
        const nextA = a.TestNavigation.takePending().navigation;
        const nextB = b.TestNavigation.takePending().navigation;
        assert.equal(nextA.plan.run_id, nextB.plan.run_id);
        assert.notEqual(nextA.plan.run_id, plan.run_id);
        assert.equal(JSON.stringify(nextA.plan.trials), JSON.stringify(nextB.plan.trials));
        plan = nextA.plan;
    }
});
