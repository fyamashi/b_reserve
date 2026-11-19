<?php
/*
 * Webブース予約 API
 * 予約データを data/bookings.csv に保存します。
 *
 *   GET  api.php?month=2026-11&place=331      … その月の予約一覧
 *   POST api.php  {"action":"save", ...}       … 予約の追加・更新
 *   POST api.php  {"action":"delete","id":..}  … 予約の削除
 */
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
date_default_timezone_set('Asia/Tokyo');

const DATA_DIR  = __DIR__ . '/data';
const CSV_FILE  = DATA_DIR . '/bookings.csv';
const COLUMNS   = ['id', 'place', 'room', 'date', 'start', 'end', 'title', 'updated_at'];
const ROOMS     = 8;
const MAX_TITLE = 80;

function respond(int $status, array $body): void {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(int $status, string $code, string $message): void {
    respond($status, ['ok' => false, 'code' => $code, 'message' => $message]);
}

/* "09:30" → 570 / 570 → "09:30"（24:00 は 1440） */
function toMin(string $hm): ?int {
    if (!preg_match('/^(\d{1,2}):(\d{2})$/', $hm, $m)) return null;
    $h = (int)$m[1]; $i = (int)$m[2];
    if ($i > 59 || $h > 24 || ($h === 24 && $i > 0)) return null;
    return $h * 60 + $i;
}
function toHm(int $min): string {
    return sprintf('%02d:%02d', intdiv($min, 60), $min % 60);
}

/* CSV を開いてロックする。$write=true なら排他ロック */
function openCsv(bool $write) {
    if (!is_dir(DATA_DIR) && !@mkdir(DATA_DIR, 0775, true)) {
        fail(500, 'storage', 'data フォルダを作成できません。サーバーの書き込み権限を確認してください。');
    }
    $fp = @fopen(CSV_FILE, $write ? 'c+' : (file_exists(CSV_FILE) ? 'r' : 'c+'));
    if (!$fp) fail(500, 'storage', 'bookings.csv を開けません。data フォルダの書き込み権限を確認してください。');
    flock($fp, $write ? LOCK_EX : LOCK_SH);
    return $fp;
}
function readRows($fp): array {
    rewind($fp);
    $rows = [];
    $first = true;
    while (($r = fgetcsv($fp, 0, ',', '"', '')) !== false) {
        if ($first) {
            $first = false;
            if (isset($r[0])) $r[0] = preg_replace('/^\xEF\xBB\xBF/', '', $r[0]); // BOM除去
            if (($r[0] ?? '') === 'id') continue;                                 // 見出し行
        }
        if (count($r) < count(COLUMNS) || $r[0] === '') continue;
        $rows[$r[0]] = array_combine(COLUMNS, array_slice($r, 0, count(COLUMNS)));
    }
    return $rows;
}
function writeRows($fp, array $rows): void {
    usort($rows, fn($a, $b) => [$a['date'], $a['room'], $a['start']] <=> [$b['date'], $b['room'], $b['start']]);
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, "\xEF\xBB\xBF"); // Excel で文字化けしないよう BOM 付き
    fputcsv($fp, COLUMNS, ',', '"', '');
    foreach ($rows as $r) {
        $line = [];
        foreach (COLUMNS as $c) $line[] = (string)$r[$c];
        fputcsv($fp, $line, ',', '"', '');
    }
    fflush($fp);
}
function toClient(array $r): array {
    return [
        'id'    => $r['id'],
        'place' => $r['place'],
        'room'  => (int)$r['room'],
        'date'  => $r['date'],
        'start' => toMin($r['start']) ?? 0,
        'end'   => toMin($r['end']) ?? 0,
        'title' => preg_replace("/^'(?=[=+\\-@])/", '', $r['title']),
    ];
}

/* ---------- GET：一覧 ---------- */
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $month = $_GET['month'] ?? '';
    $place = (string)($_GET['place'] ?? '');
    if (!preg_match('/^\d{4}-\d{2}$/', $month)) fail(400, 'bad_request', 'month の形式が正しくありません。');
    $fp = openCsv(false);
    $rows = readRows($fp);
    flock($fp, LOCK_UN); fclose($fp);
    $list = [];
    foreach ($rows as $r) {
        if (strpos($r['date'], $month) !== 0) continue;
        if ($place !== '' && $r['place'] !== $place) continue;
        $list[] = toClient($r);
    }
    respond(200, ['ok' => true, 'bookings' => $list]);
}

/* ---------- POST：保存・削除 ---------- */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'method', '許可されていない操作です。');
$in = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($in)) fail(400, 'bad_request', '送信データが正しくありません。');
$action = $in['action'] ?? '';

if ($action === 'delete') {
    $id = (string)($in['id'] ?? '');
    $fp = openCsv(true);
    $rows = readRows($fp);
    if (isset($rows[$id])) { unset($rows[$id]); writeRows($fp, $rows); }
    flock($fp, LOCK_UN); fclose($fp);
    respond(200, ['ok' => true]);
}

if ($action !== 'save') fail(400, 'bad_request', '不明な操作です。');

/* 入力チェック */
$id    = (string)($in['id'] ?? '');
$place = preg_replace('/[^0-9A-Za-z_-]/', '', (string)($in['place'] ?? ''));
$room  = (int)($in['room'] ?? 0);
$date  = (string)($in['date'] ?? '');
$start = $in['start'] ?? null;
$end   = $in['end'] ?? null;
$title = trim(preg_replace('/[\r\n\t]+/', ' ', (string)($in['title'] ?? '')));

if ($place === '')                                   fail(400, 'bad_request', '教室が指定されていません。');
if ($room < 1 || $room > ROOMS)                      fail(400, 'bad_request', '番号が正しくありません。');
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date))     fail(400, 'bad_request', '日付が正しくありません。');
if (!is_int($start) || !is_int($end) || $start < 0 || $end > 1440 || $end <= $start)
                                                     fail(400, 'bad_request', '時刻が正しくありません。');
if ($title === '')                                   fail(400, 'bad_request', '件名を入力してください。');
if (mb_strlen($title) > MAX_TITLE)                   $title = mb_substr($title, 0, MAX_TITLE);
/* Excel で開いたときに数式として解釈されないようにする */
if (preg_match('/^[=+\-@]/', $title))                $title = "'" . $title;

$fp = openCsv(true);
$rows = readRows($fp);

if ($id !== '' && !isset($rows[$id])) {
    flock($fp, LOCK_UN); fclose($fp);
    fail(404, 'not_found', 'この予約はすでに削除されています。');
}
/* 重複チェック（ロック中に行うので同時保存でも二重予約になりません） */
foreach ($rows as $r) {
    if ($r['id'] === $id) continue;
    if ($r['place'] !== $place || (int)$r['room'] !== $room || $r['date'] !== $date) continue;
    $s = toMin($r['start']); $e = toMin($r['end']);
    if ($s !== null && $e !== null && $s < $end && $start < $e) {
        flock($fp, LOCK_UN); fclose($fp);
        fail(409, 'conflict', $room . '番は ' . toHm($s) . '–' . toHm($e) . ' に「' . preg_replace("/^'(?=[=+\\-@])/", '', $r['title']) . '」が入っています。');
    }
}

if ($id === '') $id = 'b' . bin2hex(random_bytes(6));
$rows[$id] = [
    'id' => $id, 'place' => $place, 'room' => $room, 'date' => $date,
    'start' => toHm($start), 'end' => toHm($end), 'title' => $title,
    'updated_at' => date('Y-m-d H:i:s'),
];
writeRows($fp, $rows);
flock($fp, LOCK_UN); fclose($fp);
respond(200, ['ok' => true, 'id' => $id]);
