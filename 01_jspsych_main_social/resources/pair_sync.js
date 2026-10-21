/* Communication between browsers. Solo tests never contact sync.php.
   All methods return Promises; getPartnerValue/waitForPartner also accept the existing callbacks.
   Await sendValue before relying on its value being visible to the partner. */
var PairSync = {
    pairID: null, // test session code or real numeric pair ID (as a string)
    role: null,
    syncURL: 'sync/sync.php',
    testMode: false,
    solo: false,
    condition: null,
    values: null,
    simulatePartner: null,

    join: async function (sessionID, role, options) {
        options = options || {};
        this.testMode = options.testMode === true;
        this.solo = options.solo === true;
        if (this.solo && !this.testMode) throw new Error('Partner simulation is only available in test runs.');
        if (role !== 'naive' && role !== 'confederate') throw new Error('Invalid role.');
        var pattern = this.testMode ? /^test-[a-f0-9]{16}$/ : /^[1-9][0-9]*$/;
        if (!pattern.test(String(sessionID))) throw new Error('Invalid session identifier.');
        this.pairID = String(sessionID);
        this.role = role;
        this.condition = options.condition;
        this.values = Object.create(null);
        this.simulatePartner = options.simulatePartner;
        if (this.solo) return { condition: this.condition };
        var state = await this.request('join', { condition: this.condition || '' });
        this.condition = state.meta.condition;
        return state.meta;
    },

    request: async function (action, extra) {
        var response = await fetch(this.syncURL, {
            method: 'POST',
            body: new URLSearchParams(Object.assign({
                action: action,
                pair: this.pairID,
                role: this.role,
                test: this.testMode ? '1' : '0',
            }, extra)),
            cache: 'no-store',
            signal: AbortSignal.timeout(15000),
        });
        var state;
        try {
            state = await response.json();
        } catch (error) {
            throw new Error('Synchronization is unavailable. Please use a PHP server or test alone.');
        }
        if (!response.ok || state.error) throw new Error(state.error || 'Synchronization failed.');
        return state;
    },

    sendValue: async function (key, value) {
        this.values[key] = value;
        if (!this.solo) await this.request('set', { key: key, value: JSON.stringify(value) });
    },

    getPartnerValue: async function (key, callback) {
        var value;
        if (this.solo) {
            if (typeof this.simulatePartner !== 'function') throw new Error('No partner simulation is configured.');
            value = await this.simulatePartner(key, {
                role: this.role, condition: this.condition, ownValues: this.values,
            });
        } else {
            var partner = this.role === 'naive' ? 'confederate' : 'naive';
            var deadline = Date.now() + (CONFIG.timing.sync_timeout_ms || 300000);
            while (true) {
                var state = await this.request('get');
                if (Object.prototype.hasOwnProperty.call(state[partner], key)) {
                    value = state[partner][key].value;
                    break;
                }
                if (Date.now() >= deadline) throw new Error('Timed out waiting for the partner: ' + key);
                await new Promise(function (resolve) { setTimeout(resolve, CONFIG.timing.sync_poll_interval_ms); });
            }
        }
        if (callback) callback(value);
        return value;
    },

    waitForPartner: async function (step, callback) {
        if (!this.solo) {
            var key = '__ready__:' + step;
            await this.sendValue(key, true);
            await this.getPartnerValue(key);
        }
        if (callback) callback();
    },
};
