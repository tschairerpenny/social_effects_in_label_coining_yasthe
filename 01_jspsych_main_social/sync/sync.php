<?php
// Requires PHP 7.3+. Test sessions are isolated in state_test/ and never use ID management.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function failRequest($message, $status = 400) {
    http_response_code($status);
    echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') failRequest('Only POST requests are allowed.', 405);
$action = $_POST['action'] ?? '';
$pair = $_POST['pair'] ?? '';
$role = $_POST['role'] ?? '';
$test = $_POST['test'] ?? '';
if (!in_array($action, ['join', 'set', 'get', 'ready'], true) || !in_array($role, ['naive', 'confederate'], true)) {
    failRequest('Invalid action or role.');
}
if (!in_array($test, ['0', '1'], true) || !is_string($pair)) failRequest('Invalid session mode.');
$testMode = $test === '1';
if ($testMode) {
    if (!preg_match('/\Atest-[a-f0-9]{16}\z/', $pair)) failRequest('Invalid test session.');
} elseif (!preg_match('/\A[1-9][0-9]{0,15}\z/', $pair) || (float)$pair > 9007199254740991) {
    failRequest('Invalid pair ID.');
}

$condition = $_POST['condition'] ?? '';
if (!is_string($condition) || strlen($condition) > 100) failRequest('Invalid condition.');
if ($condition !== '' && !in_array($condition, ['assertive', 'compliant'], true)) failRequest('Invalid condition.');
$key = $_POST['key'] ?? '';
$value = null;
$step = $_POST['step'] ?? '';
$leadMs = filter_var($_POST['lead_ms'] ?? null, FILTER_VALIDATE_INT);
if ($action === 'ready' && (!is_string($step) || $step === '' || strlen($step) > 200 || $leadMs === false || $leadMs < 0 || $leadMs > 5000)) {
    failRequest('Invalid synchronization step or lead time.');
}
if ($action === 'set') {
    if (!is_string($key) || $key === '' || strlen($key) > 200) failRequest('Invalid message key.');
    $encodedValue = $_POST['value'] ?? '';
    if (!is_string($encodedValue)) failRequest('Invalid message value.');
    try {
        $value = json_decode($encodedValue, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        failRequest('Invalid message value.');
    }
}

$directory = __DIR__ . ($testMode ? '/state_test' : '/state');
$path = $directory . '/pair_' . $pair . '.json';
$createsSession = $action === 'join' && $role === 'naive';
if (!$createsSession && !is_file($path)) {
    failRequest('Session not found. Please prepare the participant’s computer first and check the code.', 404);
}
// c+ never truncates an existing session. All read/modify/write operations share the same lock.
$file = @fopen($path, $createsSession ? 'c+' : 'r+');
if ($file === false) failRequest('Cannot open the session. Please check write permissions for the sync directories.', 500);
if (!flock($file, LOCK_EX)) {
    fclose($file);
    failRequest('Cannot lock the session.', 500);
}

try {
    $contents = stream_get_contents($file);
    if ($contents === false) throw new RuntimeException('Cannot read the session.');
    $state = $contents === '' ? null : json_decode($contents, true, 512, JSON_THROW_ON_ERROR);
    if ($state === null) {
        if (!$createsSession || $condition === '') throw new RuntimeException('The session has not been prepared yet.');
        $state = [
            'meta' => ['condition' => $condition, 'test_mode' => $testMode],
            'joined' => [],
            'naive' => [],
            'confederate' => [],
            'barriers' => [],
        ];
    }
    if (!isset($state['meta']['condition'], $state['joined'], $state['naive'], $state['confederate']) ||
        $state['meta']['test_mode'] !== $testMode) {
        throw new RuntimeException('Invalid session file format.');
    }
    if ($action === 'join') {
        if ($condition !== '' && $condition !== $state['meta']['condition']) {
            throw new RuntimeException('The condition does not match the existing session. Please start a new session.');
        }
        $state['joined'][$role] = true;
    } else {
        if (empty($state['joined'][$role])) throw new RuntimeException('Please join the session first.');
        if ($action === 'set') {
            $state[$role][$key] = ['value' => $value, 't' => (int)round(microtime(true) * 1000)];
        } elseif ($action === 'ready') {
            if (!isset($state['barriers'][$step])) {
                $state['barriers'][$step] = ['ready' => [], 'lead_ms' => $leadMs, 'release_at_ms' => null];
            }
            $barrier = &$state['barriers'][$step];
            $barrier['ready'][$role] = true;
            $barrier['lead_ms'] = max($barrier['lead_ms'], $leadMs);
            if ($barrier['release_at_ms'] === null && !empty($barrier['ready']['naive']) && !empty($barrier['ready']['confederate'])) {
                $barrier['release_at_ms'] = (int)round(microtime(true) * 1000) + $barrier['lead_ms'];
            }
            unset($barrier);
        }
    }
    $json = json_encode($state, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    if ($action !== 'get') {
        rewind($file);
        if (fwrite($file, $json) !== strlen($json) || !ftruncate($file, strlen($json)) || !fflush($file)) {
            throw new RuntimeException('The session could not be saved completely.');
        }
    }
    // The response timestamp is not persisted: clients use it to estimate server clock offset.
    $state['server_time_ms'] = (int)round(microtime(true) * 1000);
    echo json_encode($state, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    http_response_code(500);
    echo json_encode(['error' => $error instanceof JsonException ? 'Cannot read the session file.' : $error->getMessage()], JSON_UNESCAPED_UNICODE);
} finally {
    flock($file, LOCK_UN);
    fclose($file);
}
