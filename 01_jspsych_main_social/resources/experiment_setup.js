/* Experimenter-only startup. Nothing contacts the server until the form is submitted. */
var ExperimentSetup = {
    createTestSession: function () {
        var bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        return 'test-' + Array.from(bytes, function (byte) {
            return byte.toString(16).padStart(2, '0');
        }).join('');
    },

    mount: function (root, onStart) {
        root.innerHTML = `
            <h1>Prepare experiment</h1>
            <p>For the experimenter only. Complete setup before handing over the computer.</p>
            <section id="setup-mode">
                <h2>1. Run type</h2>
                <button type="button" data-test="true">Test run</button>
                <button type="button" data-test="false">Real data collection</button>
            </section>
            <form id="setup-details" hidden>
                <p id="setup-mode-label"></p>
                <fieldset>
                    <legend>2. Role on this computer</legend>
                    <label><input type="radio" name="role" value="naive" required> Participant</label>
                    <label><input type="radio" name="role" value="confederate" required> Confederate</label>
                </fieldset>
                <fieldset id="setup-test-options" hidden>
                    <legend>Test connection</legend>
                    <label><input type="radio" name="connection" value="solo" checked> Test alone (simulate partner)</label>
                    <label><input type="radio" name="connection" value="paired"> Test with two browsers</label>
                </fieldset>
                <p id="setup-condition-row" hidden>
                    <label for="setup-condition">Test condition:</label>
                    <select id="setup-condition" name="condition"></select>
                </p>
                <p id="setup-pair-row" hidden>
                    <label for="setup-pair" id="setup-pair-label">Pair ID:</label>
                    <input id="setup-pair" name="pair" type="text" autocomplete="off">
                    <small id="setup-pair-help"></small>
                </p>
                <p id="setup-error" role="alert" hidden></p>
                <p id="setup-progress" role="status"></p>
                <button type="button" id="setup-back">Back</button>
                <button type="submit">Complete setup</button>
            </form>`;

        var testMode;
        var form = root.querySelector('form');
        var pairInput = form.elements.pair;
        var conditionSelect = form.elements.condition;
        CONFIG.conditions.forEach(function (condition) {
            var option = document.createElement('option');
            option.value = condition;
            option.textContent = CONFIG.condition_labels[condition] || condition;
            conditionSelect.appendChild(option);
        });

        function updateFields() {
            var confederate = form.elements.role.value === 'confederate';
            var solo = testMode && form.elements.connection.value === 'solo';
            var needsPair = confederate && !solo;
            root.querySelector('#setup-test-options').hidden = !testMode;
            root.querySelector('#setup-condition-row').hidden = !testMode || needsPair;
            conditionSelect.disabled = !testMode || needsPair;
            root.querySelector('#setup-pair-row').hidden = !needsPair;
            pairInput.disabled = !needsPair;
            pairInput.required = needsPair;
            pairInput.pattern = testMode ? 'test-[a-f0-9]{16}' : '[1-9][0-9]*';
            pairInput.inputMode = testMode ? 'text' : 'numeric';
            pairInput.placeholder = testMode ? 'test-0123456789abcdef' : '12';
            root.querySelector('#setup-pair-label').textContent = testMode ? 'Test session:' : 'Pair ID:';
            root.querySelector('#setup-pair-help').textContent = testMode ?
                'Copy the code from the participant’s test computer. The condition is shared automatically.' :
                'Copy the pair ID from the participant’s computer.';
        }

        root.querySelectorAll('[data-test]').forEach(function (button) {
            button.addEventListener('click', function () {
                testMode = button.dataset.test === 'true';
                root.querySelector('#setup-mode').hidden = true;
                form.hidden = false;
                root.querySelector('#setup-mode-label').textContent = testMode ?
                    'Test run: no ID management or research-data saving.' : 'Real data collection';
                updateFields();
                form.querySelector('input[name="role"]').focus();
            });
        });
        form.addEventListener('change', function () {
            pairInput.setCustomValidity('');
            updateFields();
        });
        pairInput.addEventListener('input', function () {
            pairInput.value = pairInput.value.trim().toLowerCase();
            pairInput.setCustomValidity('');
        });
        root.querySelector('#setup-back').addEventListener('click', function () {
            form.hidden = true;
            root.querySelector('#setup-mode').hidden = false;
            root.querySelector('#setup-error').hidden = true;
        });

        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            if (!form.reportValidity()) return;
            if (!testMode && !pairInput.disabled && !Number.isSafeInteger(Number(pairInput.value))) {
                pairInput.setCustomValidity('Please enter a valid positive pair ID.');
                pairInput.reportValidity();
                return;
            }
            var settings = {
                testMode: testMode,
                role: form.elements.role.value,
                solo: testMode && form.elements.connection.value === 'solo',
                condition: conditionSelect.disabled ? null : conditionSelect.value,
                pair: pairInput.disabled ? null : pairInput.value,
            };
            var controls = Array.from(form.elements);
            var wasDisabled = controls.map(function (control) { return control.disabled; });
            controls.forEach(function (control) { control.disabled = true; });
            root.querySelector('#setup-error').hidden = true;
            root.querySelector('#setup-progress').textContent = 'Preparing session …';
            try {
                await onStart(settings);
                root.hidden = true;
            } catch (error) {
                root.querySelector('#setup-error').textContent = error.message;
                root.querySelector('#setup-error').hidden = false;
                root.querySelector('#setup-progress').textContent = '';
                controls.forEach(function (control, index) { control.disabled = wasDisabled[index]; });
            }
        });
    },
};
