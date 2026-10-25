// Run with: PHP_BINARY=/path/to/php node --test tests/startup.test.cjs
// Requires Playwright and an installed browser (defaults to Edge; set BROWSER_CHANNEL as needed).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

let root, server, browser, baseURL;
const source = path.resolve(__dirname, '..');
const cdn = new Map();
const consent = '<p>Consent fixture</p><button id="start">Weiter</button>';
const fixture = (name, content) => fs.writeFileSync(path.join(root, name), content);
const calls = () => fs.existsSync(path.join(root, 'calls.log')) ? fs.readFileSync(path.join(root, 'calls.log'), 'utf8').trim().split('\n') : [];

before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'social-startup-test-'));
    for (const name of ['main_social.html', 'jspsych', 'resources', 'sync', 'stimuli']) {
        fs.cpSync(path.join(source, name), path.join(root, name), { recursive: true });
    }
    fs.mkdirSync(path.join(root, 'ID_management'));
    fixture('resources/informed-consent.js', '');
    fixture('resources/browserCheck.js', '');
    fixture('ID_management/manageID_social.php', `<?php
        file_put_contents(__DIR__.'/../calls.log', "allocate\\n", FILE_APPEND);
        echo file_exists(__DIR__.'/../id-result.txt') ? file_get_contents(__DIR__.'/../id-result.txt') : '12';`);
    fixture('ID_management/cleanupID_social.php', `<?php
        file_put_contents(__DIR__.'/../calls.log', "cleanup\\n", FILE_APPEND);
        if (file_exists(__DIR__.'/../cleanup-fail')) http_response_code(500); else echo 'ok';`);
    fixture('save_data.php', `<?php
        file_put_contents(__DIR__.'/calls.log', "save\\n", FILE_APPEND);
        if (file_exists(__DIR__.'/save-fail')) http_response_code(500); else echo 'ok';`);
    // Use the exact pinned CDN versions from the production page, cached once per test run.
    const html = fs.readFileSync(path.join(source, 'main_social.html'), 'utf8');
    await Promise.all([...html.matchAll(/<script src="(https:[^"]+)"/g)].map(async ([, url]) => {
        const response = await fetch(url);
        assert.equal(response.ok, true, url);
        cdn.set(url, await response.text());
    }));
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    baseURL = `http://127.0.0.1:${port}`;
    server = spawn(process.env.PHP_BINARY || 'php', ['-S', `127.0.0.1:${port}`, '-t', root], { windowsHide: true, stdio: 'ignore' });
    let launchError;
    server.on('error', error => { launchError = error; });
    for (let attempt = 0; attempt < 100; attempt++) {
        if (launchError) throw launchError;
        try {
            const response = await fetch(baseURL + '/main_social.html');
            await response.arrayBuffer(); // drain the response before shutting down the PHP server
            if (response.ok) break;
        } catch {}
        if (attempt === 99) throw new Error('PHP server did not start');
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
});

after(async () => {
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
        const exited = new Promise(resolve => server.once('exit', resolve));
        server.kill();
        await exited;
    }
    if (root) {
        assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'social-startup-test-')));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

async function pageFor(t, phaseOptions, localFile = false) {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.route('https://unpkg.com/**', route => route.fulfill({ contentType: 'application/javascript', body: cdn.get(route.request().url()) }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(localFile ? pathToFileURL(path.join(root, 'main_social.html')).href : baseURL + '/main_social.html');
    await page.evaluate(options => {
        if (!options || !options.phase2) Phase2.prepare = async () => ({ timeline: () => [] });
        if (!options) {
            // Startup/saving tests isolate intake from the independently tested Phase 1 task.
            Phase1.prepare = async () => ({ timeline: () => [] });
        } else {
            CONFIG.n_concepts = options.count || 16;
            CONFIG.phase1.n_fillers = options.fillers === undefined ? 3 : options.fillers;
            CONFIG.timing.phase1_label_entry_ms = options.entryMs || 5000;
            CONFIG.timing.phase1_discussion_ms = options.discussionMs === undefined ? 300 : options.discussionMs;
            CONFIG.timing.phase1_sync_lead_ms = 80;
            CONFIG.timing.sync_poll_interval_ms = 20;
            CONFIG.timing.sync_timeout_ms = 10000;
            CONFIG.timing.phase2_feedback_ms = options.feedbackMs === undefined ? 500 : options.feedbackMs;
            CONFIG.timing.phase2_sync_lead_ms = 80;
            if (options.phase1Fixture) {
                const preparePhase1 = Phase1.prepare.bind(Phase1);
                Phase1.prepare = async (settings, condition) => {
                    const controller = await preparePhase1(settings, condition);
                    controller.results = controller.plan.trials.map(item => ({
                        phase1_run_id: controller.plan.run_id, trial: item.trial, concept_id: item.concept_id, stimulus: item.image,
                        participant_label: 'Phase 1 participant word ' + item.concept_id,
                        confederate_label: item.confederate_label, confederate_assigned_label: item.confederate_label,
                        label_slot: item.label_slot, label_quality: item.label_quality,
                    }));
                    controller.timeline = () => [];
                    window.phase1Fixture = controller;
                    return controller;
                };
            }
        }
    }, phaseOptions || null);
    return page;
}

async function choose(page, { testMode = true, role = 'naive', paired = false, pair, condition } = {}) {
    await page.getByRole('button', { name: testMode ? 'Test run' : 'Real data collection', exact: true }).click();
    await page.locator(`input[name=role][value=${role}]`).check();
    if (testMode && paired) await page.locator('input[name=connection][value=paired]').check();
    if (pair) await page.locator('#setup-pair').fill(pair);
    if (condition) await page.locator('#setup-condition').selectOption(condition);
}

async function submit(page) {
    await page.getByRole('button', { name: 'Complete setup' }).click();
    await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
}

async function finish(page) {
    const role = await page.evaluate(() => PairSync.role);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('button', { name: role === 'naive' ? 'Starten' : 'Start experiment', exact: true }).click();
    if (role === 'naive') {
        await page.getByRole('button', { name: /^(Continue test|Weiter)$/ }).click();
        const age = page.getByRole('spinbutton', { name: /Ihr Alter/ });
        await age.waitFor();
        // Required responses and validation must stay in German for the participant.
        await page.getByRole('button', { name: 'Weiter', exact: true }).click();
        await page.getByText('Bitte beantworten Sie diese Frage.', { exact: true }).first().waitFor();
        if (process.env.SCREENSHOT_DIR) {
            await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'participant-demographics.png'), fullPage: true });
        }
        await age.fill('25');
        await page.getByRole('textbox', { name: /Ihr Geschlecht/ }).fill('divers');
        // Blur before clicking: clearing SurveyJS validation messages moves the controls.
        await page.getByRole('textbox', { name: /Ihr Geschlecht/ }).press('Tab');
        await page.getByRole('radio', { name: 'Ja', exact: true }).check();
        await page.getByRole('textbox', { name: /Ihre Muttersprache/ }).fill('Deutsch');
        await page.getByRole('textbox', { name: /Ihre Muttersprache/ }).press('Tab');
        await page.getByRole('button', { name: 'Weiter', exact: true }).click();
    }
}

test('startup has no network side effects; URL flags cannot bypass the choices', async t => {
    const page = await pageFor(t);
    const previous = calls();
    const posts = [];
    page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
    await page.goto(baseURL + '/main_social.html?test=1&role=naive');
    await choose(page);
    assert.deepEqual(posts, []);
    assert.deepEqual(calls(), previous);
    assert.equal(await page.locator('#setup-mode-label').textContent(), 'Test run: no ID management or research-data saving.');
    assert.deepEqual(await page.locator('#setup-condition option').allTextContents(), ['Assertive', 'Compliant']);
    assert.equal(await page.getByRole('radio', { name: 'Participant', exact: true }).isVisible(), true);
    if (process.env.SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'startup-test-options.png'), fullPage: true });
    }
});

for (const role of ['naive', 'confederate']) {
    test(`solo ${role} bypasses all server writes, simulates partner, and downloads tagged CSV`, async t => {
        const page = await pageFor(t);
        const posts = [];
        const consentRequests = [];
        page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
        page.on('request', request => { if (request.url().includes('/informedconsent_social_de.html')) consentRequests.push(request.url()); });
        await choose(page, { role, condition: 'compliant' });
        await submit(page);
        assert.match(await page.locator('#experiment').innerText(), /Condition: Compliant/);
        assert.equal(await page.locator('#test-mode-banner').isVisible(), true);
        const result = await page.evaluate(async () => {
            await PairSync.sendValue('phase1_label_c1', 'Eigenes Wort');
            await PairSync.waitForPartner('phase1_start_c1');
            return [await PairSync.getPartnerValue('phase1_label_c1'), await PairSync.getPartnerValue('phase1_choice_c1')];
        });
        assert.deepEqual(result, ['Testbegriff c1', 'Eigenes Wort']);
        await finish(page);
        const link = page.getByRole('link', { name: 'Download test data (CSV)' });
        await link.waitFor();
        const csv = await page.evaluate(async () => (await fetch(document.querySelector('#test-data-download').href)).text());
        assert.match(csv, /test_mode/);
        assert.match(csv, /compliant/);
        assert.match(csv, /test-[a-f0-9]{16}/);
        assert.match(await link.getAttribute('download'), new RegExp(`^TEST_social_test-[a-f0-9]{16}_${role}_\\d+\\.csv$`));
        const rows = await page.evaluate(() => jsPsych.data.get().values());
        assert.ok(rows.every(row => row.pair_id === null && row.test_mode === true && row.role === role && row.connection_mode === 'solo'));
        const demographics = rows.filter(row => row.phase === 'demographics');
        if (role === 'naive') {
            assert.equal(demographics.length, 1);
            const { age, gender, monolingual_german, nat_lang } = demographics[0].response;
            assert.deepEqual({ age, gender, monolingual_german, nat_lang }, { age: 25, gender: 'divers', monolingual_german: 'Ja', nat_lang: 'Deutsch' });
            assert.equal(rows.filter(row => row.phase === 'consent_test_placeholder').length, 1);
        } else {
            assert.equal(demographics.length, 0);
            assert.ok(rows.every(row => row.phase !== 'consent' && row.phase !== 'consent_test_placeholder'));
            assert.deepEqual(consentRequests, []);
        }
        assert.deepEqual(posts, []);
    });
}

for (const role of ['naive', 'confederate']) {
    test(`direct local HTML solo test (${role}) starts and completes Phase 1 without fetching local CSV or PHP`, async t => {
        const page = await pageFor(t, { count: 2, fillers: 1, discussionMs: 0 }, true);
        const requests = [];
        page.on('request', request => {
            if (request.method() === 'POST' || request.url().endsWith('/concepts.csv')) requests.push(request.url());
        });
        await choose(page, { role });
        await page.getByRole('button', { name: 'Complete setup' }).click();
        await page.waitForFunction(() => !document.querySelector('#setup-error').hidden || document.querySelector('.jspsych-html-button-response-button'));
        assert.equal(await page.locator('#setup-error').isVisible(), false, await page.locator('#setup-error').textContent());
        await finish(page);
        await startPhase1(page);
        for (let index = 0; index < 2; index++) {
            await stage(page, 'generation').waitFor();
            if (role === 'naive') await page.locator('#phase1-label').fill('Lokaler Begriff ' + index);
            await page.getByRole('button', { name: role === 'naive' ? 'Begriff abgeben' : 'Submit label', exact: true }).click();
            await stage(page, 'choice').waitFor();
            await stage(page, 'choice').locator('button[data-source]:enabled').first().click();
            await stage(page, 'reveal').waitFor();
            await page.getByRole('button', { name: role === 'naive' ? 'Weiter' : 'Continue', exact: true }).click();
        }
        await page.locator('#test-data-download').waitFor();
        const rows = await page.evaluate(() => jsPsych.data.get().values().filter(row => row.phase === 'phase1'));
        assert.equal(rows.length, 2);
        assert.ok(rows.every(row => row.condition === 'assertive'));
        assert.deepEqual(requests, []);
    });
}

test('HTTP stimulus request failures show an actionable error and can be retried', async t => {
    const page = await pageFor(t, { count: 2, fillers: 1, discussionMs: 0 });
    await page.route('**/stimuli/concepts.csv', route => route.abort('failed'));
    await choose(page);
    await page.getByRole('button', { name: 'Complete setup' }).click();
    await page.locator('#setup-error:visible').waitFor();
    assert.match(await page.locator('#setup-error').textContent(), /Cannot load stimuli\/concepts.csv.*server connection/);
    assert.equal(await page.getByRole('button', { name: 'Complete setup' }).isEnabled(), true);
    await page.unroute('**/stimuli/concepts.csv');
    await submit(page);
});

test('direct local HTML explains why real and two-browser sessions need a PHP server', async t => {
    for (const testMode of [true, false]) {
        const page = await pageFor(t, { count: 2, fillers: 1 }, true);
        const posts = [];
        page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
        await choose(page, { testMode, paired: testMode });
        await page.getByRole('button', { name: 'Complete setup' }).click();
        await page.locator('#setup-error:visible').waitFor();
        assert.match(await page.locator('#setup-error').textContent(), /PHP server/);
        assert.deepEqual(posts, []);
    }
});

test('paired tests share their condition, exchange values/barriers, and never touch real state or ID endpoints', async t => {
    const a = await pageFor(t), b = await pageFor(t);
    const previous = calls();
    await choose(a, { paired: true, condition: 'compliant' });
    await submit(a);
    const session = await a.evaluate(() => PairSync.pairID);
    await choose(b, { role: 'confederate', paired: true, pair: session });
    await submit(b);
    assert.equal(await b.evaluate(() => PairSync.condition), 'compliant');
    await a.evaluate(() => PairSync.sendValue('phase1_label_c1', 'Wort A'));
    assert.equal(await b.evaluate(() => PairSync.getPartnerValue('phase1_label_c1')), 'Wort A');
    await b.evaluate(() => PairSync.sendValue('phase2_feedback_c1', false));
    assert.equal(await a.evaluate(() => PairSync.getPartnerValue('phase2_feedback_c1')), false);
    await Promise.all([a.evaluate(() => PairSync.waitForPartner('shared-step')), b.evaluate(() => PairSync.waitForPartner('shared-step'))]);
    assert.ok(fs.existsSync(path.join(root, 'sync/state_test', `pair_${session}.json`)));
    assert.deepEqual(fs.readdirSync(path.join(root, 'sync/state')).filter(name => name.endsWith('.json')), []);
    await finish(a);
    await a.locator('#test-data-download').waitFor();
    await finish(b);
    await b.locator('#test-data-download').waitFor();
    assert.deepEqual(calls(), previous);
});

test('unknown test session produces a recoverable startup error', async t => {
    const page = await pageFor(t);
    await choose(page, { role: 'confederate', paired: true, pair: 'test-ffffffffffffffff' });
    await page.getByRole('button', { name: 'Complete setup' }).click();
    await page.locator('#setup-error:visible').waitFor();
    assert.match(await page.locator('#setup-error').textContent(), /Session not found/);
    assert.equal(await page.getByRole('button', { name: 'Complete setup' }).isEnabled(), true);
    assert.equal(await page.locator('#setup-pair').isEnabled(), true);
    assert.equal(await page.locator('#setup-condition').isDisabled(), true);
});

test('real startup refuses a missing consent form before allocating an ID', async t => {
    const page = await pageFor(t);
    const previous = calls();
    await choose(page, { testMode: false });
    await page.getByRole('button', { name: 'Complete setup' }).click();
    await page.locator('#setup-error:visible').waitFor();
    assert.match(await page.locator('#setup-error').textContent(), /consent form/);
    assert.deepEqual(calls(), previous);
});

test('real confederate needs no consent form or demographics', async t => {
    const response = await fetch(baseURL + '/sync/sync.php', {
        method: 'POST', body: new URLSearchParams({ action: 'join', role: 'naive', pair: '14', test: '0', condition: 'compliant' }),
    });
    assert.equal(response.ok, true);
    await response.json();
    const page = await pageFor(t);
    const consentRequests = [];
    page.on('request', request => { if (request.url().includes('/informedconsent_social_de.html')) consentRequests.push(request.url()); });
    await choose(page, { testMode: false, role: 'confederate', pair: '14' });
    await submit(page);
    await finish(page);
    await page.getByText('Please contact the experimenter.', { exact: true }).waitFor();
    const rows = await page.evaluate(() => jsPsych.data.get().values());
    assert.ok(rows.every(row => !['demographics', 'consent', 'consent_test_placeholder'].includes(row.phase)));
    assert.deepEqual(consentRequests, []);
});

test('real participant allocates once; confederate joins; only participant cleans up after successful saving', async t => {
    fixture('resources/informedconsent_social_de.html', consent);
    const previousCount = calls().length;
    const a = await pageFor(t), b = await pageFor(t);
    await choose(a, { testMode: false });
    await submit(a);
    await choose(b, { testMode: false, role: 'confederate', pair: '12' });
    await submit(b);
    assert.equal(await a.evaluate(() => PairSync.condition), 'compliant');
    assert.equal(await b.evaluate(() => PairSync.condition), 'compliant');
    await finish(b);
    await b.getByText('Please contact the experimenter.', { exact: true }).waitFor();
    assert.deepEqual(calls().slice(previousCount), ['allocate', 'save']);
    await finish(a);
    await a.getByText('Bitte wenden Sie sich an die Versuchsleitung.', { exact: true }).waitFor();
    assert.deepEqual(calls().slice(previousCount), ['allocate', 'save', 'save', 'cleanup']);
    const rows = await a.evaluate(() => jsPsych.data.get().values());
    assert.ok(rows.every(row => row.pair_id === 12 && row.test_mode === false));
    assert.equal(rows.filter(row => row.phase === 'demographics').length, 1);
    assert.equal(rows.filter(row => row.phase === 'consent').length, 1);
    const confederateRows = await b.evaluate(() => jsPsych.data.get().values());
    assert.ok(confederateRows.every(row => row.phase !== 'demographics' && row.phase !== 'consent'));
});

test('failed research-data saving does not clean up an ID; retry succeeds', async t => {
    fixture('save-fail', '1');
    const previousCount = calls().length;
    const page = await pageFor(t);
    await choose(page, { testMode: false });
    await submit(page);
    await finish(page);
    await page.getByRole('button', { name: 'Erneut versuchen' }).waitFor();
    assert.deepEqual(calls().slice(previousCount), ['allocate', 'save']);
    fs.unlinkSync(path.join(root, 'save-fail'));
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await page.getByText('Bitte wenden Sie sich an die Versuchsleitung.', { exact: true }).waitFor();
    assert.deepEqual(calls().slice(previousCount), ['allocate', 'save', 'save', 'cleanup']);
});

test('failed ID cleanup retries without saving the research data twice', async t => {
    fixture('cleanup-fail', '1');
    const previousCount = calls().length;
    const page = await pageFor(t);
    await choose(page, { testMode: false });
    await submit(page);
    await finish(page);
    await page.getByRole('button', { name: 'Erneut versuchen' }).waitFor();
    assert.deepEqual(calls().slice(previousCount), ['allocate', 'save', 'cleanup']);
    fs.unlinkSync(path.join(root, 'cleanup-fail'));
    await page.getByRole('button', { name: 'Erneut versuchen' }).click();
    await page.getByText('Bitte wenden Sie sich an die Versuchsleitung.', { exact: true }).waitFor();
    assert.deepEqual(calls().slice(previousCount), ['allocate', 'save', 'cleanup', 'cleanup']);
});

test('empty or malformed ID responses stay on setup and never join sync', async t => {
    for (const invalid of ['', 'NaN', '12junk', '0', '9007199254740992']) {
        fixture('id-result.txt', invalid);
        const page = await pageFor(t);
        await choose(page, { testMode: false });
        await page.getByRole('button', { name: 'Complete setup' }).click();
        await page.locator('#setup-error:visible').waitFor();
        assert.match(await page.locator('#setup-error').textContent(), /no pair IDs|valid positive pair ID/);
    }
    fs.unlinkSync(path.join(root, 'id-result.txt'));
});

test('PHP rejects test/live identifier crossover and path traversal', async () => {
    for (const [pair, testMode] of [['12', '1'], ['test-0123456789abcdef', '0'], ['../state/pair_12', '1']]) {
        const response = await fetch(baseURL + '/sync/sync.php', {
            method: 'POST', body: new URLSearchParams({ action: 'join', role: 'naive', pair, test: testMode, condition: 'assertive' }),
        });
        assert.equal(response.status, 400);
        assert.ok((await response.json()).error);
    }
});

async function startPhase1(page) {
    const role = await page.evaluate(() => PairSync.role);
    await page.getByRole('button', { name: role === 'naive' ? 'Teil 1 starten' : 'Begin Phase 1', exact: true }).click();
}

function stage(page, name) { return page.locator(`.phase1-stage[data-stage="${name}"]`); }

async function startPhase2(page) {
    const role = await page.evaluate(() => PairSync.role);
    await page.getByRole('button', { name: role === 'naive' ? 'Teil 2 starten' : 'Begin Phase 2', exact: true }).click();
}

function phase2Stage(page, name, trial, attempt) {
    return page.locator(`.phase2-stage[data-stage="${name}"][data-trial="${trial}"][data-attempt="${attempt}"]`);
}

test('paired Phases 1 and 2 complete all 16 shared pictures and record linked labels, timings, attempts, and feedback', async t => {
    const previous = calls();
    // Leave enough time to inspect transient screens on both browser contexts.
    const a = await pageFor(t, { discussionMs: 1500, phase2: true, feedbackMs: 1000 });
    const b = await pageFor(t, { discussionMs: 1500, phase2: true, feedbackMs: 1000 });
    await choose(a, { paired: true, condition: 'assertive' });
    await submit(a);
    const session = await a.evaluate(() => PairSync.pairID);
    const plan = await a.evaluate(() => PairSync.values.phase1_plan);
    assert.equal(plan.trials.length, 16);
    await choose(b, { role: 'confederate', paired: true, pair: session });
    await submit(b);
    await Promise.all([finish(a), finish(b)]);
    await startPhase1(a);
    await stage(a, 'waiting').waitFor();
    assert.equal(await stage(a, 'waiting').locator('img').isVisible(), false);
    await startPhase1(b);
    let interrupted = false;
    let phase2InterruptedEntry;
    await a.route('**/sync/sync.php', async route => {
        const payload = new URLSearchParams(route.request().postData());
        if (!interrupted && payload.get('action') === 'set' && payload.get('key').endsWith('_t1_label')) {
            interrupted = true;
            await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary test interruption' }) });
        } else if (!phase2InterruptedEntry && payload.get('action') === 'set' && payload.get('key').startsWith('phase2_') && payload.get('key').endsWith('_t1_a1_label')) {
            phase2InterruptedEntry = JSON.parse(payload.get('value'));
            await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Phase 2 temporary test interruption' }) });
        } else await route.continue();
    });

    for (let index = 0; index < plan.trials.length; index++) {
        const item = plan.trials[index];
        await Promise.all([stage(a, 'generation').waitFor(), stage(b, 'generation').waitFor()]);
        assert.match(await stage(a, 'generation').locator('img').getAttribute('src'), new RegExp(item.image.replace('.', '\\.')));
        assert.equal(await stage(a, 'generation').locator('img').getAttribute('src'), await stage(b, 'generation').locator('img').getAttribute('src'));
        assert.equal(await b.locator('#phase1-label').inputValue(), item.confederate_label);
        assert.match(await stage(b, 'generation').locator('.phase1-guidance').innerText(), new RegExp(item.strategy === 'assertive' ? 'Assertive' : 'Compliant'));
        assert.equal(await stage(a, 'generation').locator('.phase1-guidance').innerText(), '');
        const word = index === 0 ? 'Eigenes <b>Wort</b>' : `Eigenes Wort ${index + 1}`;
        await a.locator('#phase1-label').fill(word);
        await a.getByRole('button', { name: 'Begriff abgeben', exact: true }).click();
        if (index === 0) {
            await a.getByRole('button', { name: 'Erneut versuchen', exact: true }).click();
            assert.equal(await a.locator('#phase1-label').count(), 0); // retry must not restart generation/RT
        }
        await stage(a, 'waiting').waitFor();
        assert.equal(await stage(a, 'waiting').locator('.phase1-labels').innerText(), '');
        assert.equal(await stage(b, 'generation').locator('.phase1-labels').innerText(), '');
        await b.getByRole('button', { name: 'Submit label', exact: true }).click();
        await Promise.all([stage(a, 'discussion').waitFor(), stage(b, 'discussion').waitFor()]);
        assert.match(await stage(a, 'discussion').locator('.phase1-labels').innerText(), new RegExp(item.confederate_label));
        assert.ok((await stage(b, 'discussion').locator('.phase1-labels').innerText()).includes(word));
        // Labels are rendered as text, including arbitrary user-entered markup.
        assert.equal(await stage(b, 'discussion').locator('.phase1-labels b').count(), 0);
        if (index === 0 && process.env.SCREENSHOT_DIR) {
            await b.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'phase1-confederate-discussion.png'), fullPage: true });
        }
        await Promise.all([stage(a, 'choice').waitFor(), stage(b, 'choice').waitFor()]);
        const expected = item.strategy === 'assertive' ? 'confederate' : 'naive';
        assert.equal(await stage(b, 'choice').locator(`button[data-source="${expected}"]`).isEnabled(), true);
        assert.equal(await stage(b, 'choice').locator(`button[data-source="${expected === 'naive' ? 'confederate' : 'naive'}"]`).isEnabled(), false);
        await stage(a, 'choice').locator('button[data-source="naive"]').click();
        await stage(a, 'waiting').waitFor();
        assert.equal(await a.locator('[data-choice-source]').count(), 0);
        await stage(b, 'choice').locator(`button[data-source="${expected}"]`).click();
        await Promise.all([stage(a, 'reveal').waitFor(), stage(b, 'reveal').waitFor()]);
        assert.ok((await a.locator('[data-choice-source="naive"]').innerText()).includes(word));
        assert.ok((await b.locator('[data-choice-source="naive"]').innerText()).includes(word));
        await a.getByRole('button', { name: 'Weiter', exact: true }).click();
        await b.getByRole('button', { name: 'Continue', exact: true }).click();
    }

    await startPhase2(a);
    await phase2Stage(a, 'waiting', 1, 1).waitFor();
    assert.equal(await a.locator('.phase2-stage img').count(), 0);
    await startPhase2(b);
    const expectedPhase2 = [];
    let assertiveIndex = 0;
    for (const item of plan.trials) {
        const ordinal = item.strategy === 'assertive' ? assertiveIndex++ : -1;
        const succeedsAt = item.strategy === 'compliant' ? 1 : (ordinal === 0 ? null : ordinal === 1 ? 1 : ordinal === 2 ? 2 : 3);
        const attempts = succeedsAt || 3;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const expectedCorrect = item.strategy === 'compliant' || attempt === succeedsAt;
            const label = item.strategy === 'assertive' && expectedCorrect ?
                '  ' + item.confederate_label.toLocaleLowerCase('de-DE') + '  ' : `Anderes <b>Wort</b> ${item.trial}-${attempt}`;
            await phase2Stage(a, 'generation', item.trial, attempt).waitFor();
            assert.match(await a.locator('.phase2-image').getAttribute('src'), new RegExp(item.image.replace('.', '\\.')));
            assert.equal(await a.locator('.phase2-guidance').innerText(), '');
            await a.locator('#phase2-label').fill(label);
            await a.getByRole('button', { name: 'Begriff abgeben', exact: true }).click();
            if (item.trial === 1 && attempt === 1) await a.getByRole('button', { name: 'Erneut versuchen', exact: true }).click();
            await phase2Stage(b, 'judgment', item.trial, attempt).waitFor();
            assert.equal(await b.locator('.phase2-stage img').count(), 0);
            assert.ok((await b.locator('.phase2-guidance').innerText()).includes(item.confederate_label));
            assert.ok((await b.locator('.phase2-submitted-label').innerText()).includes(label.trim()));
            assert.equal(await b.locator('.phase2-submitted-label b').count(), 0);
            assert.equal(await b.getByRole('button', { name: expectedCorrect ? 'Correct' : 'Incorrect', exact: true }).isEnabled(), true);
            assert.equal(await b.getByRole('button', { name: expectedCorrect ? 'Incorrect' : 'Correct', exact: true }).isEnabled(), false);
            await b.getByRole('button', { name: expectedCorrect ? 'Correct' : 'Incorrect', exact: true }).click();
            await Promise.all([phase2Stage(a, 'feedback', item.trial, attempt).waitFor(), phase2Stage(b, 'feedback', item.trial, attempt).waitFor()]);
            assert.equal(await a.locator('.phase2-feedback').getAttribute('data-correct'), String(expectedCorrect));
            assert.equal(await b.locator('.phase2-feedback').getAttribute('data-correct'), String(expectedCorrect));
            if (item.trial === 1 && attempt === 1 && process.env.SCREENSHOT_DIR) {
                await b.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'phase2-confederate-feedback.png'), fullPage: true });
            }
            expectedPhase2.push({ item, attempt, label, correct: expectedCorrect, complete: expectedCorrect || attempt === 3 });
        }
    }
    await Promise.all([a.locator('#test-data-download').waitFor(), b.locator('#test-data-download').waitFor()]);
    const aRows = await a.evaluate(() => jsPsych.data.get().values().filter(row => row.phase === 'phase1'));
    const bRows = await b.evaluate(() => jsPsych.data.get().values().filter(row => row.phase === 'phase1'));
    assert.equal(aRows.length, 16); assert.equal(bRows.length, 16);
    assert.equal(interrupted, true);
    assert.equal(aRows.filter(row => row.is_filler).length, 3);
    assert.equal(aRows.filter(row => row.label_quality === 'good').length, 8);
    assert.equal(aRows.filter(row => row.label_quality === 'bad').length, 8);
    for (let index = 0; index < aRows.length; index++) {
        const row = aRows[index], other = bRows[index];
        assert.equal(row.stimulus, other.stimulus);
        assert.equal(row.participant_label, other.participant_label);
        assert.equal(row.participant_choice, row.participant_label);
        assert.equal(row.participant_choice, other.participant_choice);
        assert.equal(row.confederate_choice_source, row.confederate_strategy === 'assertive' ? 'confederate' : 'naive');
        assert.equal(row.label_timed_out, false);
        assert.ok(row.participant_label_rt >= 0 && row.participant_label_rt < 5000);
        assert.ok(row.participant_choice_rt >= 0);
        assert.ok(row.discussion_elapsed_ms >= 1490);
        assert.equal(row.generation_scheduled_server_ms, other.generation_scheduled_server_ms);
        assert.equal(row.discussion_scheduled_server_ms, other.discussion_scheduled_server_ms);
        assert.equal(row.reveal_scheduled_server_ms, other.reveal_scheduled_server_ms);
    }
    const csv = await a.evaluate(async () => (await fetch(document.querySelector('#test-data-download').href)).text());
    for (const column of ['participant_label', 'participant_label_rt', 'participant_choice', 'is_filler', 'label_quality']) assert.ok(csv.includes(column));
    const aAttempts = await a.evaluate(() => jsPsych.data.get().values().filter(row => row.phase === 'phase2'));
    const bAttempts = await b.evaluate(() => jsPsych.data.get().values().filter(row => row.phase === 'phase2'));
    assert.equal(aAttempts.length, expectedPhase2.length);
    assert.equal(bAttempts.length, expectedPhase2.length);
    assert.ok(phase2InterruptedEntry);
    assert.equal(aAttempts[0].participant_label_rt, phase2InterruptedEntry.rt);
    for (let index = 0; index < expectedPhase2.length; index++) {
        const expected = expectedPhase2[index], row = aAttempts[index], partner = bAttempts[index];
        const phase1 = aRows.find(previous => previous.concept_id === expected.item.concept_id);
        assert.equal(row.concept_id, expected.item.concept_id);
        assert.equal(row.stimulus, phase1.stimulus);
        assert.equal(row.phase1_run_id, phase1.phase1_run_id);
        assert.equal(row.phase1_participant_label, phase1.participant_label);
        assert.equal(row.confederate_label, phase1.confederate_label);
        assert.equal(row.is_filler, phase1.is_filler);
        assert.equal(row.attempt, expected.attempt);
        assert.equal(row.participant_label, expected.label.trim());
        assert.equal(row.participant_label_raw, expected.label);
        assert.equal(row.feedback_correct, expected.correct);
        assert.equal(row.picture_complete, expected.complete);
        assert.equal(row.end_reason, expected.correct ? 'correct' : expected.complete ? 'max_attempts' : null);
        assert.ok(row.participant_label_rt >= 0);
        assert.equal(row.participant_label, partner.participant_label);
        assert.equal(row.participant_label_rt, partner.participant_label_rt);
        assert.equal(row.feedback_correct, partner.feedback_correct);
        assert.equal(row.feedback_scheduled_server_ms, partner.feedback_scheduled_server_ms);
    }
    for (const column of ['attempt', 'feedback_correct', 'phase1_confederate_label', 'participant_label_raw']) assert.ok(csv.includes(column));
    assert.deepEqual(calls(), previous);
});

for (const role of ['naive', 'confederate']) {
    test(`solo Phase 1 (${role}) completes with simulated partner, including a missing-label timeout`, async t => {
        const previous = calls();
        const page = await pageFor(t, { count: 2, fillers: 1, entryMs: role === 'naive' ? 500 : 5000, discussionMs: 0 });
        await choose(page, { role, condition: 'compliant' });
        await submit(page);
        await finish(page);
        await startPhase1(page);
        for (let index = 0; index < 2; index++) {
            await stage(page, 'generation').waitFor();
            if (role === 'confederate') {
                assert.equal(await page.locator('#phase1-label').getAttribute('readonly'), '');
                await page.getByRole('button', { name: 'Submit label', exact: true }).click();
            } else if (index === 1) {
                await page.locator('#phase1-label').fill('Mein Wort');
                await page.getByRole('button', { name: 'Begriff abgeben', exact: true }).click();
            } // first participant label is deliberately left empty until the deadline
            await stage(page, 'choice').waitFor();
            await stage(page, 'choice').locator('button[data-source]:enabled').first().click();
            await stage(page, 'reveal').waitFor();
            await page.getByRole('button', { name: role === 'naive' ? 'Weiter' : 'Continue', exact: true }).click();
        }
        await page.locator('#test-data-download').waitFor();
        const rows = await page.evaluate(() => jsPsych.data.get().values().filter(row => row.phase === 'phase1'));
        assert.equal(rows.length, 2);
        if (role === 'naive') {
            assert.equal(rows[0].participant_label, null);
            assert.equal(rows[0].participant_label_rt, null);
            assert.equal(rows[0].participant_label_timed_out, true);
            assert.equal(rows[0].strategy_fallback, 'missing_participant_label');
            assert.equal(rows[1].participant_label, 'Mein Wort');
            assert.equal(rows[1].participant_label_timed_out, false);
        }
        assert.deepEqual(calls(), previous);
    });
}

for (const condition of ['assertive', 'compliant']) {
    for (const role of ['naive', 'confederate']) {
        test(`local-file solo Phase 2 (${condition}, ${role}) links Phase 1 labels and completes both regular and filler rules`, async t => {
            const previous = calls();
            const page = await pageFor(t, { count: 2, fillers: 1, phase2: true, phase1Fixture: true, feedbackMs: 0 }, true);
            const posts = [];
            page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
            await choose(page, { role, condition });
            await submit(page);
            const fixture = await page.evaluate(() => ({ plan: window.phase1Fixture.plan, results: window.phase1Fixture.results }));
            await finish(page);
            await startPhase2(page);
            for (const item of fixture.plan.trials) {
                const attempts = item.strategy === 'assertive' ? 3 : 1;
                for (let attempt = 1; attempt <= attempts; attempt++) {
                    if (role === 'naive') {
                        await phase2Stage(page, 'generation', item.trial, attempt).waitFor();
                        const label = attempt === 3 ? item.confederate_label : 'Anderer Begriff';
                        await page.locator('#phase2-label').fill(label);
                        await page.getByRole('button', { name: 'Begriff abgeben', exact: true }).click();
                    } else {
                        await phase2Stage(page, 'judgment', item.trial, attempt).waitFor();
                        assert.equal(await page.locator('.phase2-stage img').count(), 0);
                        await page.locator('.phase2-controls button[data-correct]:enabled').click();
                    }
                }
            }
            await page.locator('#test-data-download').waitFor();
            const rows = await page.evaluate(() => jsPsych.data.get().values().filter(row => row.phase === 'phase2'));
            assert.equal(rows.length, 4); // one compliant attempt plus three assertive attempts
            for (const row of rows) {
                const reference = fixture.results.find(previous => previous.concept_id === row.concept_id);
                assert.equal(row.confederate_label, reference.confederate_label);
                assert.equal(row.phase1_participant_label, reference.participant_label);
                assert.equal(row.condition, condition);
                assert.equal(row.feedback_correct, row.confederate_strategy === 'compliant' || row.label_matches_confederate);
                assert.ok(row.attempt >= 1 && row.attempt <= 3);
                assert.ok(row.participant_label_rt >= 0);
            }
            assert.deepEqual(posts, []);
            assert.deepEqual(calls(), previous);
        });
    }
}
