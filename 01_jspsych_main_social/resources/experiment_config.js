/* ------------------------------------------------------------------------------------------------
   EXPERIMENT CONFIGURATION
   All parameters that are likely to change go here, so that main_social.html contains only the
   experimental logic and resources/pair_sync.js only the communication between the two browsers.
   Nothing in this file talks to the server.
   ------------------------------------------------------------------------------------------------ */

var CONFIG = {

    // TODO: conditions. Recommended: assign by pair ID so the conditions stay balanced,
    // e.g. odd pair IDs -> 'assertive', even pair IDs -> 'compliant' (see getCondition below).
    conditions: ['assertive', 'compliant'],
    // Canonical condition values are used in the task, session state, and saved data.
    condition_labels: { assertive: 'Assertive', compliant: 'Compliant' },

    // TODO: timing in milliseconds (values from the study description)
    timing: {
        phase1_label_entry_ms: 120000,  // time to think of and enter a label
        phase1_discussion_ms: 60000,    // discussion of the two labels
        phase1_sync_lead_ms: 1500,     // future server release gives both browsers time to prepare
        phase2_feedback_ms: 2000,       // feedback after each picture selection
        sync_poll_interval_ms: 500,     // how often the browser asks the server for news
        sync_timeout_ms: 300000,        // allow the partner's full two-minute label-entry window
    },

    // Random sample without replacement, selected once per pair from concepts.csv.
    n_concepts: 16,
    phase1: {
        n_fillers: 3,
        label_policy: 'balanced',      // 8 good / 8 bad; good1-4 and bad1-4 each used twice
        max_label_length: 120,
    },
    // TODO: trials per concept for phase 2
    phase2_trials_per_concept: null,

    // TODO: confederate behaviour in phase 2 (assertive condition), e.g. how many incorrect
    // selections before the correct one, and the randomisation rule for that number.
    confederate: {
        n_incorrect_before_correct: null,
    },

    // Stimuli: one row per concept (concept_nr, concept_id, image, good1-good4, bad1-bad4), made by
    // ../00_stimuli_selection/select_stimuli_main.py. Images are in stimuli/pictures/.
    // Load and parse it like stimuli_lists.csv in Exp2 (fetchCSV + parseCSV in goodness_ratings.html).
    // TODO: decide which label the confederate uses per concept (e.g. a fixed good label) and
    // which images serve as distractors in phase 2 (e.g. images of other concepts).
    stimuli_file: 'stimuli/concepts.csv',

    // Solo-test fixtures, deliberately separate from the real confederate's behaviour.
    // Extend this function when phase 2 introduces new message keys/response formats.
    testing: {
        partnerValue: function (key, context) {
            if (/^phase1_label_c\d+$/.test(key)) {
                return 'Testbegriff ' + key.split('_').pop();
            }
            if (/^phase1_choice_c\d+$/.test(key)) {
                var labelKey = key.replace('_choice_', '_label_');
                if (context.role === 'naive' && context.condition === 'assertive') {
                    return CONFIG.testing.partnerValue(labelKey, context);
                }
                return context.ownValues[labelKey] || 'Testbegriff';
            }
            if (Object.prototype.hasOwnProperty.call(context.ownValues, key)) {
                return context.ownValues[key];
            }
            throw new Error('Add a test value for this message type in CONFIG.testing.partnerValue: ' + key);
        },
    },
};

// TODO: rule that maps a pair ID to a condition
function getCondition(pairID) {
    return CONFIG.conditions[(pairID - 1) % CONFIG.conditions.length];
}
