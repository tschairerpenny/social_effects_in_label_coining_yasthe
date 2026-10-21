// Run with: PHP_BINARY=/path/to/php node --test tests/startup.test.cjs
// Requires Playwright and an installed browser (defaults to Edge; set BROWSER_CHANNEL as needed).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    for (const name of ['main_social.html', 'jspsych', 'resources', 'sync']) {
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

async function pageFor(t) {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.route('https://unpkg.com/**', route => route.fulfill({ contentType: 'application/javascript', body: cdn.get(route.request().url()) }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(baseURL + '/main_social.html');
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
        await choose(page, { role, condition: 'accommodating' });
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
        assert.match(csv, /accommodating/);
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

test('paired tests share their condition, exchange values/barriers, and never touch real state or ID endpoints', async t => {
    const a = await pageFor(t), b = await pageFor(t);
    const previous = calls();
    await choose(a, { paired: true, condition: 'accommodating' });
    await submit(a);
    const session = await a.evaluate(() => PairSync.pairID);
    await choose(b, { role: 'confederate', paired: true, pair: session });
    await submit(b);
    assert.equal(await b.evaluate(() => PairSync.condition), 'accommodating');
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
        method: 'POST', body: new URLSearchParams({ action: 'join', role: 'naive', pair: '14', test: '0', condition: 'accommodating' }),
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
    assert.equal(await a.evaluate(() => PairSync.condition), 'accommodating');
    assert.equal(await b.evaluate(() => PairSync.condition), 'accommodating');
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
            method: 'POST', body: new URLSearchParams({ action: 'join', role: 'naive', pair, test: testMode, condition: 'consistent' }),
        });
        assert.equal(response.status, 400);
        assert.ok((await response.json()).error);
    }
});
