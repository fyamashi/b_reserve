/**
 * Webブース予約 Google Apps Script
 * 予約データをこのスプレッドシートの「bookings」シートに保存します。
 *
 * 使い方
 *   1. Googleスプレッドシートを新規作成
 *   2. 拡張機能 → Apps Script を開き、このコードを貼り付けて保存
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行：自分
 *        アクセスできるユーザー：全員
 *   4. 表示された URL（…/exec）を config.js の gasUrl に貼り付け
 *
 * 保存形式は api.php の CSV と同じ列なので、どちらの環境へも移せます。
 */

const SHEET_NAME = 'bookings';
const COLUMNS = ['id', 'place', 'room', 'date', 'start', 'end', 'title', 'updated_at'];
const ROOMS = 8;
const MAX_TITLE = 80;

/* ---------- 入口 ---------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action !== 'list') return json_({ ok: true, app: 'webbooth' });
  const month = String(p.month || '');
  const place = String(p.place || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return fail_('bad_request', 'month の形式が正しくありません。');
  const list = readRows_(sheet_())
    .filter(r => r.date.indexOf(month) === 0 && (place === '' || r.place === place))
    .map(toClient_);
  return json_({ ok: true, bookings: list });
}

function doPost(e) {
  let input;
  try { input = JSON.parse(e.postData.contents); }
  catch (err) { return fail_('bad_request', '送信データが正しくありません。'); }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return fail_('busy', '混み合っています。もう一度お試しください。');
  try {
    if (input.action === 'delete') return deleteBooking_(String(input.id || ''));
    if (input.action === 'save') return saveBooking_(input);
    return fail_('bad_request', '不明な操作です。');
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 保存・削除 ---------- */
function saveBooking_(input) {
  const id = String(input.id || '');
  const place = String(input.place || '').replace(/[^0-9A-Za-z_-]/g, '');
  const room = Number(input.room);
  const date = String(input.date || '');
  const start = input.start, end = input.end;
  let title = String(input.title || '').replace(/[\r\n\t]+/g, ' ').trim();

  if (!place) return fail_('bad_request', '教室が指定されていません。');
  if (!(room >= 1 && room <= ROOMS && Math.floor(room) === room)) return fail_('bad_request', '番号が正しくありません。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail_('bad_request', '日付が正しくありません。');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || end <= start)
    return fail_('bad_request', '時刻が正しくありません。');
  if (!title) return fail_('bad_request', '件名を入力してください。');
  if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE);

  const sh = sheet_();
  const rows = readRows_(sh);

  let target = null;
  if (id) {
    target = rows.find(r => r.id === id);
    if (!target) return fail_('not_found', 'この予約はすでに削除されています。');
  }
  // 重複チェック（ロック中なので同時保存でも二重予約にならない）
  for (const r of rows) {
    if (r.id === id || r.place !== place || Number(r.room) !== room || r.date !== date) continue;
    const s = toMin_(r.start), en = toMin_(r.end);
    if (s !== null && en !== null && s < end && start < en) {
      return fail_('conflict', '番号' + room + 'は ' + toHm_(s) + '–' + toHm_(en) + ' に「' + cleanTitle_(r.title) + '」が入っています。');
    }
  }

  const newId = id || 'b' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  const values = [[
    newId, place, String(room), date, toHm_(start), toHm_(end),
    /^[=+\-@]/.test(title) ? "'" + title : title,   // 数式として解釈されないように
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
  ]];
  const rowNo = target ? target._row : sh.getLastRow() + 1;
  const range = sh.getRange(rowNo, 1, 1, COLUMNS.length);
  range.setNumberFormat('@');   // 日付・時刻が自動変換されないよう文字列で保存
  range.setValues(values);
  return json_({ ok: true, id: newId });
}

function deleteBooking_(id) {
  const sh = sheet_();
  const target = readRows_(sh).find(r => r.id === id);
  if (target) sh.deleteRow(target._row);
  return json_({ ok: true });
}

/* ---------- シート ---------- */
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, COLUMNS.length).getDisplayValues()
    .map((v, i) => {
      const r = { _row: i + 2 };
      COLUMNS.forEach((c, j) => { r[c] = String(v[j]); });
      return r;
    })
    .filter(r => r.id !== '');
}

function toClient_(r) {
  return {
    id: r.id, place: r.place, room: Number(r.room), date: r.date,
    start: toMin_(r.start) || 0, end: toMin_(r.end) || 0, title: cleanTitle_(r.title)
  };
}

/* ---------- 小さな関数 ---------- */
function cleanTitle_(t) { return String(t).replace(/^'(?=[=+\-@])/, ''); }
function toMin_(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm));
  if (!m) return null;
  const h = Number(m[1]), i = Number(m[2]);
  if (i > 59 || h > 24 || (h === 24 && i > 0)) return null;
  return h * 60 + i;
}
function toHm_(min) { return ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2); }
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(code, message) { return json_({ ok: false, code: code, message: message }); }
