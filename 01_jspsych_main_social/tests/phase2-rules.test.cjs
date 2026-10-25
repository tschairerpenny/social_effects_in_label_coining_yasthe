const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function environment() {
    const context = vm.createContext({ PairSync: { solo: false } });
    for (const file of ['experiment_config.js', 'phase1.js', 'phase2.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../resources', file), 'utf8'), context);
    }
    return context;
}

function phase1Fixture(role = 'naive') {
    return {
        role,
        plan: { run_id: '12345678-1234-4123-8123-123456789abc', condition: 'assertive', trials: [
            { trial: 1, concept_id: '82', image: '82.jpg', strategy: 'assertive', is_filler: false, confederate_label: 'Original assignment' },
        ] },
        results: [{ trial: 1, concept_id: '82', stimulus: '82.jpg', phase1_run_id: '12345678-1234-4123-8123-123456789abc',
            participant_label: 'Participant phase one word', confederate_label: 'Actual Phase One Word' }],
    };
}

test('feedback follows both base conditions and reverses on fillers', () => {
    const { Phase1, Phase2 } = environment();
    for (const condition of ['assertive', 'compliant']) {
        for (const filler of [false, true]) {
            const strategy = Phase1.strategy(condition, filler);
            assert.equal(Phase2.requiredFeedback(strategy, 'Other word', 'Reference'), strategy === 'compliant');
            assert.equal(Phase2.requiredFeedback(strategy, 'Reference', 'Reference'), true);
        }
    }
    assert.throws(() => Phase2.requiredFeedback('unknown', 'word', 'word'), /Unknown/);
});

test('label matching ignores case, outside whitespace, and Unicode composition but preserves the word itself', () => {
    const { Phase2 } = environment();
    assert.equal(Phase2.labelsMatch('  SCHIRMLAMPE  ', 'Schirmlampe'), true);
    assert.equal(Phase2.labelsMatch('Gebäck', 'Geba\u0308ck'), true);
    assert.equal(Phase2.labelsMatch('Schirmlampen', 'Schirmlampe'), false);
    assert.equal(Phase2.labelsMatch('Schirmlampe!', 'Schirmlampe'), false);
    assert.equal(Phase2.labelsMatch(' ', ''), false);
    assert.equal(Phase2.labelsMatch(null, 'word'), false);
});

test('correct feedback stops immediately; incorrect feedback allows at most three attempts', () => {
    const { Phase2 } = environment();
    assert.equal(Phase2.pictureComplete(true, 1, 3), true);
    assert.equal(Phase2.pictureComplete(true, 2, 3), true);
    assert.equal(Phase2.pictureComplete(false, 1, 3), false);
    assert.equal(Phase2.pictureComplete(false, 2, 3), false);
    assert.equal(Phase2.pictureComplete(false, 3, 3), true);
});

test('Phase 2 joins the actual Phase 1 label to its concept and run, not just the original assignment', async () => {
    const { Phase2 } = environment();
    const phase1 = phase1Fixture();
    const controller = await Phase2.prepare(phase1, { solo: true, role: 'naive' });
    const item = phase1.plan.trials[0];
    assert.equal(controller.phase1Record(item).confederate_label, 'Actual Phase One Word');
    const key = 'phase2_' + phase1.plan.run_id + '_t1_a1_feedback';
    const result = controller.simulatePartner(key, { ownValues: {
        [key.replace('_feedback', '_label')]: { label: ' ACTUAL PHASE ONE WORD ' },
    } });
    assert.equal(result.correct, true);
    phase1.results[0].phase1_run_id = 'another run';
    assert.throws(() => controller.phase1Record(item), /missing/);
});

test('scripted feedback and response payloads are validated before use', () => {
    const { Phase2 } = environment();
    const entry = { label: 'Word', raw_label: ' Word ', rt: 123 };
    assert.equal(Phase2.validateLabel(entry), entry);
    assert.throws(() => Phase2.validateLabel({ label: '', raw_label: ' ', rt: 123 }), /Invalid/);
    assert.throws(() => Phase2.validateLabel({ ...entry, rt: Infinity }), /Invalid/);
    assert.equal(Phase2.validateFeedback({ correct: false, rt: 12 }, false).correct, false);
    assert.throws(() => Phase2.validateFeedback({ correct: true, rt: 12 }, false), /strategy/);
});

test('solo confederate simulation submits non-matching words then the Phase 1 label on its third try', async () => {
    const { Phase2 } = environment();
    const phase1 = phase1Fixture('confederate');
    const controller = await Phase2.prepare(phase1, { solo: true, role: 'confederate' });
    for (let attempt = 1; attempt <= 3; attempt++) {
        const entry = controller.simulatePartner('phase2_' + phase1.plan.run_id + '_t1_a' + attempt + '_label', {});
        assert.equal(Phase2.labelsMatch(entry.label, phase1.results[0].confederate_label), attempt === 3);
        Phase2.validateLabel(entry);
    }
});

test('invalid Phase 2 settings cannot silently exceed the three-attempt limit', async () => {
    const { Phase2, CONFIG } = environment();
    CONFIG.phase2.max_attempts = 4;
    await assert.rejects(Phase2.prepare(phase1Fixture(), { solo: true, role: 'naive' }), /Invalid/);
});
