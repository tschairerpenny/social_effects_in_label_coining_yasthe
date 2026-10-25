const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');

function environment() {
    // HTTP LAN origins may have getRandomValues but no crypto.randomUUID.
    const context = vm.createContext({ crypto: { getRandomValues: array => webcrypto.getRandomValues(array) } });
    for (const file of ['experiment_config.js', 'phase1.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, 'resources', file), 'utf8'), context);
    }
    context.rows = context.Phase1.parseCSV(fs.readFileSync(path.join(root, 'stimuli/concepts.csv'), 'utf8'));
    return context;
}

test('real CSV yields 16 unique images, 3 fillers, 8 good/8 bad labels, and two uses of each label slot', () => {
    const { Phase1, rows } = environment();
    for (const condition of ['assertive', 'compliant']) {
        const plan = Phase1.makePlan(rows, condition);
        assert.equal(plan.trials.length, 16);
        assert.equal(new Set(plan.trials.map(item => item.concept_id)).size, 16);
        assert.equal(new Set(plan.trials.map(item => item.image)).size, 16);
        assert.equal(plan.trials.filter(item => item.is_filler).length, 3);
        for (const quality of ['good', 'bad']) {
            assert.equal(plan.trials.filter(item => item.label_quality === quality).length, 8);
            for (let slot = 1; slot <= 4; slot++) {
                assert.equal(plan.trials.filter(item => item.label_slot === quality + slot).length, 2);
            }
        }
        for (const item of plan.trials) {
            const row = rows.find(row => row.concept_id === item.concept_id);
            assert.equal(item.confederate_label, row[item.label_slot]);
            assert.equal(fs.existsSync(path.join(root, 'stimuli/pictures', item.image)), true);
            assert.equal(item.strategy, (condition === 'assertive') !== item.is_filler ? 'assertive' : 'compliant');
        }
        assert.equal(plan.trials.filter(item => item.choice_order[0] === 'naive').length, 8);
    }
});

test('the three fillers reverse each base condition and simulation follows the current trial strategy', () => {
    const { Phase1, rows } = environment();
    for (const condition of ['assertive', 'compliant']) {
        const plan = Phase1.makePlan(rows, condition);
        for (const item of plan.trials) {
            const key = `phase1_${plan.run_id}_t${item.trial}`;
            const context = { role: 'naive', ownValues: { [key + '_label']: { label: 'Participant word' } } };
            assert.equal(Phase1.simulatePartner(plan, key + '_label', context).label, item.confederate_label);
            const choice = Phase1.simulatePartner(plan, key + '_choice', context);
            assert.equal(choice.source, item.strategy === 'assertive' ? 'confederate' : 'naive');
            assert.equal(choice.label, item.strategy === 'assertive' ? item.confederate_label : 'Participant word');
        }
    }
});

test('CSV parser handles BOM, CRLF, quoted commas, quotes, and newlines', () => {
    const { Phase1 } = environment();
    const rows = Phase1.parseCSV('\uFEFFimage,label\r\na.jpg,"a,b"\r\nb.jpg,"a""b"\r\nc.jpg,"a\nb"\r\n');
    assert.equal(rows[0].label, 'a,b');
    assert.equal(rows[1].label, 'a"b');
    assert.equal(rows[2].label, 'a\nb');
    assert.throws(() => Phase1.parseCSV('image,label\na.jpg,"unfinished'), /Invalid/);
});

test('shared-plan validation rejects changed labels, duplicate pictures, and unsafe image paths', () => {
    const { Phase1, rows } = environment();
    const original = Phase1.makePlan(rows, 'assertive');
    const altered = change => {
        const plan = JSON.parse(JSON.stringify(original)); change(plan);
        assert.throws(() => Phase1.validatePlan(plan, rows, 'assertive'), /Invalid/);
    };
    altered(plan => { plan.trials[0].confederate_label = 'Different label'; });
    altered(plan => { plan.trials[1] = { ...plan.trials[0], trial: 2 }; });
    altered(plan => { plan.trials[0].image = '../other.jpg'; });
    altered(plan => { plan.trials[0].strategy = plan.trials[0].strategy === 'assertive' ? 'compliant' : 'assertive'; });
});

test('impossible counts and unbalanced requested trial counts fail before the experiment starts', () => {
    const { CONFIG, Phase1, rows } = environment();
    CONFIG.n_concepts = 21;
    assert.throws(() => Phase1.makePlan(rows, 'assertive'), /counts/);
    CONFIG.n_concepts = 15;
    assert.throws(() => Phase1.makePlan(rows, 'assertive'), /even/);
    CONFIG.n_concepts = 16; CONFIG.phase1.n_fillers = 17;
    assert.throws(() => Phase1.makePlan(rows, 'assertive'), /counts/);
});

test('direct-file stimulus copy exactly matches the canonical CSV', async () => {
    const context = environment();
    vm.runInContext(fs.readFileSync(path.join(root, 'stimuli/concepts.js'), 'utf8'), context);
    const csv = fs.readFileSync(path.join(root, 'stimuli/concepts.csv'), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    assert.equal(context.LOCAL_STIMULI.source, 'stimuli/concepts.csv');
    assert.equal(context.LOCAL_STIMULI.csv, csv);
    context.location = { protocol: 'file:' };
    context.fetch = () => { throw new Error('Local preview must not fetch a CSV file'); };
    assert.equal((await context.Phase1.loadStimuli({ testMode: true, solo: true })).length, 20);
    await assert.rejects(context.Phase1.loadStimuli({ testMode: true, solo: false }), /PHP server/);
    await assert.rejects(context.Phase1.loadStimuli({ testMode: false, solo: true }), /PHP server/);
});

test('conditions use the canonical names in configuration and plans', () => {
    const { CONFIG, Phase1, rows } = environment();
    assert.equal(JSON.stringify(CONFIG.conditions), JSON.stringify(['assertive', 'compliant']));
    for (const condition of CONFIG.conditions) assert.equal(Phase1.makePlan(rows, condition).condition, condition);
});
