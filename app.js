/* Webブース予約 */
(function(){
  "use strict";
  const ROOMS = 8;
  const DOW = ["日","月","火","水","木","金","土"];
  const $ = id => document.getElementById(id);

  // ---------- 日付ユーティリティ ----------
  const pad = n => String(n).padStart(2,"0");
  const iso = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
  const parseIso = s => { const [y,m,d] = s.split("-").map(Number); return new Date(y,m-1,d); };
  const monthKey = d => d.getFullYear()+"-"+pad(d.getMonth()+1);
  const fmtMin = m => pad(Math.floor(m/60))+":"+pad(m%60);
  const toMin = v => { if(!v) return null; const [h,m] = v.split(":").map(Number); return h*60+m; };
  const jpDate = d => d.getFullYear()+"年"+(d.getMonth()+1)+"月"+d.getDate()+"日";

  // ---------- 状態 ----------
  let selDate = new Date(); selDate.setHours(0,0,0,0);
  let calMonth = new Date(selDate.getFullYear(), selDate.getMonth(), 1);
  const byMonth = {};        // "2026-10" -> [予約]
  const subs = {};           // "2026-10" -> unsubscribe
  let store = null;
  let editing = null;        // {id?, room, date}

  // ---------- 設定（config.js） ----------
  const CFG = Object.assign({
    backend: "auto",     // "firebase" | "gas" | "php" | "local" | "auto"
    firebase: null,
    firebaseCollection: "webbooth",
    gasUrl: "",
    phpUrl: "api.php",
    pollSeconds: 10,
    places: [{id:"331", name:"331教室"}]
  }, window.WEBBOOTH_CONFIG || {});

  const currentPlace = () => ($("placeSelect") && $("placeSelect").value) || (CFG.places[0] && CFG.places[0].id) || "331";

  // ---------- 保存先アダプタ ----------
  // どの保存先も list / save / remove の3つだけを持ち、画面側はこの違いを意識しない。
  function apiError(body, status){
    const e = new Error((body && body.message) || ("通信エラー (" + status + ")"));
    e.code = (body && body.code) || "network";
    return e;
  }
  async function readJson(res){
    let body = null; try { body = await res.json(); } catch(e){}
    if(!body || !body.ok) throw apiError(body, res.status);
    return body;
  }

  // Google Apps Script（スプレッドシート）
  function gasBackend(url){
    return {
      label: "Googleスプレッドシート",
      async list(month, place){
        const res = await fetch(url + "?" + new URLSearchParams({action:"list", month, place}), {cache:"no-store"});
        return (await readJson(res)).bookings;
      },
      async save(b){
        // text/plain にすると CORS の事前確認が不要になり、GAS で受け取れる
        const res = await fetch(url, {method:"POST", headers:{"Content-Type":"text/plain;charset=utf-8"}, body:JSON.stringify(Object.assign({action:"save"}, b))});
        return readJson(res);
      },
      async remove(id){
        const res = await fetch(url, {method:"POST", headers:{"Content-Type":"text/plain;charset=utf-8"}, body:JSON.stringify({action:"delete", id})});
        return readJson(res);
      }
    };
  }

  // PHP（api.php → data/bookings.csv）
  function phpBackend(url){
    return {
      label: "サーバー(CSV)",
      async list(month, place){
        const res = await fetch(url + "?" + new URLSearchParams({month, place}), {cache:"no-store"});
        return (await readJson(res)).bookings;
      },
      async save(b){
        const res = await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(Object.assign({action:"save"}, b))});
        return readJson(res);
      },
      async remove(id){
        const res = await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"delete", id})});
        return readJson(res);
      }
    };
  }

  // 共有保存先を「月ごとの購読」に変換（定期的に読み直す）
  function remoteStore(backend){
    const watchers = {};   // month -> [callback]
    let failed = false;
    async function load(key){
      try {
        const list = await backend.list(key, currentPlace());
        if(failed){ failed = false; toast("接続が回復しました。"); }
        (watchers[key] || []).forEach(cb => cb(list));
      } catch(e){
        console.error(e);
        if(!failed){ failed = true; toast("予約データを読み込めませんでした。" + (e.code === "network" ? "" : e.message)); }
      }
    }
    const refreshAll = () => Object.keys(watchers).forEach(load);
    setInterval(() => { if(!document.hidden) refreshAll(); }, Math.max(3, CFG.pollSeconds) * 1000);
    document.addEventListener("visibilitychange", () => { if(!document.hidden) refreshAll(); });
    return {
      shared: true,
      label: backend.label,
      refreshAll,
      subscribeMonth(key, cb){
        (watchers[key] = watchers[key] || []).push(cb);
        load(key);
        return () => { watchers[key] = (watchers[key] || []).filter(f => f !== cb); if(!watchers[key].length) delete watchers[key]; };
      },
      async save(b){
        await backend.save({id:b.id || "", place:b.place, room:b.room, date:b.date, start:b.start, end:b.end, title:b.title});
        await load(b.date.slice(0,7));
      },
      async remove(id){ await backend.remove(id); refreshAll(); }
    };
  }

  // ---------- Firebase（Firestore）：リアルタイム共有 ----------
  // 1つの文書 = ある教室・日付・番号の予約まとめ（例：331_2026-11-18_3）。
  // 保存はトランザクションで「読む→重なりを確認→書く」を一度に行うため、
  // 2人が同時に同じ枠を保存しても二重予約になりません。
  const FB_VER = "10.12.2";
  async function firebaseStore(conf, colName){
    const base = "https://www.gstatic.com/firebasejs/" + FB_VER + "/";
    const appMod = await import(base + "firebase-app.js");
    const fs = await import(base + "firebase-firestore.js");
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(conf);
    const db = fs.getFirestore(app);
    const col = fs.collection(db, colName);
    const dayId = (place, date, room) => place + "_" + date + "_" + room;
    const known = {};   // id -> 予約（削除時に文書を特定するため）

    function overlap(items, start, end, exceptId){
      for(const [id, it] of Object.entries(items || {})){
        if(id !== exceptId && it.start < end && start < it.end) return it;
      }
      return null;
    }
    function conflictError(room, it){
      const e = new Error("番号" + room + "は " + fmtMin(it.start) + "–" + fmtMin(it.end) + " に「" + (it.title || "件名なし") + "」が入っています。");
      e.code = "conflict"; return e;
    }

    return {
      shared: true,
      label: "Firebase",
      subscribeMonth(key, cb){
        const q = fs.query(col, fs.where("pm", "==", currentPlace() + "_" + key));
        return fs.onSnapshot(q, {includeMetadataChanges:true}, snap => {
          const list = [];
          snap.forEach(d => {
            const v = d.data(), pending = d.metadata.hasPendingWrites;
            Object.entries(v.items || {}).forEach(([id, it]) => {
              const b = {id, place:v.place, room:v.room, date:v.date, start:it.start, end:it.end, title:it.title, pending};
              known[id] = b; list.push(b);
            });
          });
          cb(list);
        }, e => {
          console.error(e);
          toast(e.code === "permission-denied"
            ? "Firebase のセキュリティルールで読み込みが拒否されました。firebase/firestore.rules を設定してください。"
            : "予約データを受信できませんでした。ページを再読み込みしてください。");
        });
      },
      async save(b){
        const id = b.id || ("b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
        const newRef = fs.doc(col, dayId(b.place, b.date, b.room));
        const old = b.id ? known[b.id] : null;
        const oldRef = old && dayId(old.place, old.date, old.room) !== newRef.id ? fs.doc(col, dayId(old.place, old.date, old.room)) : null;
        await fs.runTransaction(db, async tx => {
          const snap = await tx.get(newRef);
          const oldSnap = oldRef ? await tx.get(oldRef) : null;
          const items = snap.exists() ? (snap.data().items || {}) : {};
          if(b.id && !items[b.id] && !(oldSnap && oldSnap.exists() && (oldSnap.data().items || {})[b.id])){
            const e = new Error("この予約はすでに削除されています。"); e.code = "not_found"; throw e;
          }
          const hit = overlap(items, b.start, b.end, id);
          if(hit) throw conflictError(b.room, hit);
          const item = {start:b.start, end:b.end, title:b.title, updatedAt:fs.serverTimestamp()};
          if(snap.exists()) tx.update(newRef, {["items." + id]: item});
          else tx.set(newRef, {pm: b.place + "_" + b.date.slice(0,7), place:b.place, date:b.date, room:b.room, items:{[id]: item}});
          if(oldSnap && oldSnap.exists()){
            const rest = Object.keys(oldSnap.data().items || {}).filter(k => k !== id);
            if(rest.length) tx.update(oldRef, {["items." + id]: fs.deleteField()});
            else tx.delete(oldRef);
          }
        });
      },
      async remove(id){
        const b = known[id]; if(!b) return;
        const ref = fs.doc(col, dayId(b.place, b.date, b.room));
        await fs.runTransaction(db, async tx => {
          const snap = await tx.get(ref);
          if(!snap.exists()) return;
          const rest = Object.keys(snap.data().items || {}).filter(k => k !== id);
          if(rest.length) tx.update(ref, {["items." + id]: fs.deleteField()});
          else tx.delete(ref);
        });
      }
    };
  }

  // api.php が動く環境かどうかを確かめる（"auto" のとき）
  async function phpAvailable(url){
    if(!location.protocol.startsWith("http")) return false;
    try {
      const res = await fetch(url + "?" + new URLSearchParams({month:"2000-01", place:currentPlace()}), {cache:"no-store"});
      const body = await res.json();
      return !!(body && body.ok);
    } catch(e){ return false; }
  }


  function localStore(){
    let all = {};
    try { all = JSON.parse(localStorage.getItem("webbooth.bookings")||"{}") || {}; } catch(e){ all = {}; }
    const listeners = {};
    const inMonth = k => Object.values(all).filter(b => b.date.startsWith(k) && (b.place || "331") === currentPlace());
    const persist = () => { try { localStorage.setItem("webbooth.bookings", JSON.stringify(all)); } catch(e){} };
    const emit = () => Object.keys(listeners).forEach(k => listeners[k].forEach(cb => cb(inMonth(k))));
    return {
      shared:false,
      subscribeMonth(key, cb){
        (listeners[key] = listeners[key] || []).push(cb);
        cb(inMonth(key));
        return () => { listeners[key] = (listeners[key]||[]).filter(f => f!==cb); };
      },
      async save(b){ const id = b.id || ("b"+Date.now().toString(36)+Math.random().toString(36).slice(2,6)); all[id] = {id, place:b.place, room:b.room, date:b.date, start:b.start, end:b.end, title:b.title}; persist(); emit(); },
      async remove(id){ delete all[id]; persist(); emit(); }
    };
  }

  function syncSubscriptions(){
    if(!store) return;
    const want = new Set([monthKey(selDate), monthKey(calMonth)]);
    Object.keys(subs).forEach(k => { if(!want.has(k)){ subs[k](); delete subs[k]; delete byMonth[k]; } });
    want.forEach(k => {
      if(subs[k]) return;
      subs[k] = store.subscribeMonth(k, list => { byMonth[k] = list; renderBookings(); renderCalendar(); });
    });
  }
  const dayBookings = dateStr => (byMonth[dateStr.slice(0,7)] || []).filter(b => b.date === dateStr);

  // ---------- 行の高さ：初期表示で 8〜16時（9行）が収まるように ----------
  const scroller = $("scroller");
  function rowH(){ return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row")) || 56; }
  function fitRows(){
    const head = 44;
    const avail = scroller.clientHeight - head;
    const h = Math.max(40, Math.min(96, Math.floor(avail / 9)));
    document.documentElement.style.setProperty("--row", h+"px");
    return h;
  }

  // ---------- グリッド ----------
  const grid = $("grid");
  function buildGrid(){
    let html = '<div class="ghead corner"></div>';
    for(let r=1;r<=ROOMS;r++) html += '<div class="ghead"><small>番号</small>'+r+'</div>';
    html += '<div class="tcol">';
    for(let h=0;h<24;h++) html += '<div class="tlabel"><span>'+h+'</span></div>';
    html += '</div>';
    for(let r=1;r<=ROOMS;r++) html += '<div class="room" data-room="'+r+'"><div class="ghost"></div></div>';
    grid.innerHTML = html;

    grid.querySelectorAll(".room").forEach(col => {
      const ghost = col.querySelector(".ghost");
      col.addEventListener("mousemove", e => {
        if(e.target.closest(".booking")){ ghost.style.display="none"; return; }
        ghost.style.display="";
        const s = slotAt(col, e.clientY);
        ghost.style.top = (s/60*rowH())+"px";
        ghost.style.height = (30/60*rowH())+"px";
        ghost.textContent = fmtMin(s);
      });
      col.addEventListener("click", e => {
        const bk = e.target.closest(".booking");
        if(bk){ openEdit(bk.dataset.id); return; }
        const s = slotAt(col, e.clientY);
        openNew(+col.dataset.room, s, Math.min(s+30, 1440));
      });
    });
  }
  function slotAt(col, clientY){
    const y = clientY - col.getBoundingClientRect().top;
    const min = Math.max(0, Math.min(1439, Math.floor(y / rowH() * 60)));
    return Math.floor(min/30)*30;
  }

  function renderBookings(){
    const ds = iso(selDate);
    const list = dayBookings(ds);
    const h = rowH();
    grid.querySelectorAll(".room").forEach(col => {
      col.querySelectorAll(".booking,.nowline").forEach(n => n.remove());
      const r = +col.dataset.room;
      list.filter(b => b.room === r).sort((a,b) => a.start-b.start).forEach(b => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "booking" + (b.pending ? " pending" : "");
        el.dataset.id = b.id;
        const top = b.start/60*h, ht = Math.max(18, (b.end-b.start)/60*h - 2);
        el.style.top = top+"px"; el.style.height = ht+"px";
        if(ht < 38) el.classList.add("compact");
        const t = document.createElement("b"); t.textContent = b.title || "（件名なし）";
        const s = document.createElement("span"); s.textContent = fmtMin(b.start)+"–"+fmtMin(b.end);
        el.append(t, s);
        el.setAttribute("aria-label", "番号"+r+" "+fmtMin(b.start)+"から"+fmtMin(b.end)+" "+(b.title||"件名なし"));
        col.appendChild(el);
      });
      if(ds === iso(new Date())){
        const now = new Date(); const m = now.getHours()*60+now.getMinutes();
        const line = document.createElement("div"); line.className = "nowline";
        line.style.top = (m/60*h)+"px";
        if(r !== 1) line.classList.add("plain");
        col.appendChild(line);
      }
    });
  }

  // ---------- 日付ヘッダ ----------
  function renderHeader(){
    const d = selDate.getDay();
    const cls = d===0 ? "sun" : d===6 ? "sat" : "";
    $("dateLabel").innerHTML = jpDate(selDate) + '<span class="dow '+cls+'">('+DOW[d]+')</span>';
  }

  // ---------- 月間カレンダー ----------
  function renderCalendar(){
    $("calTitle").textContent = calMonth.getFullYear()+"年"+(calMonth.getMonth()+1)+"月";
    const g = $("calGrid");
    let html = DOW.map((w,i) => '<div class="cal-dow'+(i===0?" sun":i===6?" sat":"")+'">'+w+'</div>').join("");
    const start = new Date(calMonth); start.setDate(1 - calMonth.getDay());
    const todayStr = iso(new Date()), selStr = iso(selDate);
    const has = new Set((byMonth[monthKey(calMonth)]||[]).map(b => b.date));
    for(let i=0;i<42;i++){
      const d = new Date(start); d.setDate(start.getDate()+i);
      const ds = iso(d), w = d.getDay();
      let c = "cal-day";
      if(d.getMonth() !== calMonth.getMonth()) c += " out";
      if(w===0) c += " sun"; if(w===6) c += " sat";
      if(ds===todayStr) c += " today";
      if(ds===selStr) c += " sel";
      if(has.has(ds)) c += " has";
      html += '<button class="'+c+'" data-date="'+ds+'" aria-label="'+jpDate(d)+'">'+d.getDate()+'</button>';
    }
    g.innerHTML = html;
  }
  $("calGrid").addEventListener("click", e => {
    const b = e.target.closest(".cal-day"); if(!b) return;
    setDate(parseIso(b.dataset.date));
    closeSide();
  });
  $("calPrev").onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth()-1, 1); syncSubscriptions(); renderCalendar(); };
  $("calNext").onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth()+1, 1); syncSubscriptions(); renderCalendar(); };
  $("todayBtn").onclick = () => { const t = new Date(); t.setHours(0,0,0,0); setDate(t); closeSide(); };

  function setDate(d){
    selDate = d;
    calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    syncSubscriptions();
    renderHeader(); renderCalendar(); renderBookings();
  }
  $("dayPrev").onclick = () => { const d = new Date(selDate); d.setDate(d.getDate()-1); setDate(d); };
  $("dayNext").onclick = () => { const d = new Date(selDate); d.setDate(d.getDate()+1); setDate(d); };

  // ---------- スマホ用ドロワー ----------
  const side = $("side"), scrim = $("scrim");
  $("menuBtn").onclick = () => { side.classList.add("open"); scrim.classList.add("open"); };
  function closeSide(){ side.classList.remove("open"); scrim.classList.remove("open"); }
  scrim.onclick = closeSide;

  // ---------- 入力ウィンドウ ----------
  const overlay = $("overlay");
  const mRoom = $("mRoom");
  for(let r=1;r<=ROOMS;r++){ const o = document.createElement("option"); o.value = r; o.textContent = "番号 "+r; mRoom.appendChild(o); }
  const toInput = m => m >= 1440 ? "00:00" : fmtMin(m);

  function openNew(room, start, end){
    editing = {room, date: iso(selDate)};
    $("mHeading").textContent = "新しい予約";
    $("mTitle").value = "";
    fillModal(room, start, end);
    $("mDelete").hidden = true;
    showModal();
  }
  function openEdit(id){
    const b = dayBookings(iso(selDate)).find(x => x.id === id); if(!b) return;
    editing = {id, room:b.room, date:b.date};
    $("mHeading").textContent = "予約の編集";
    $("mTitle").value = b.title || "";
    fillModal(b.room, b.start, b.end);
    $("mDelete").hidden = false;
    showModal();
  }
  function fillModal(room, start, end){
    const d = parseIso(editing.date);
    $("mDate").textContent = jpDate(d)+"("+DOW[d.getDay()]+")";
    mRoom.value = room;
    $("mStart").value = toInput(start);
    $("mEnd").value = toInput(end);
    $("mErr").textContent = "";
    $("mSave").disabled = !store;
  }
  function showModal(){
    overlay.classList.add("open");
    setTimeout(() => $("mTitle").focus(), 30);
  }
  function closeModal(){ overlay.classList.remove("open"); editing = null; }

  // ×で閉じる＝入力は破棄
  $("mClose").onclick = closeModal;
  overlay.addEventListener("click", e => { if(e.target === overlay) closeModal(); });
  document.addEventListener("keydown", e => { if(e.key === "Escape" && overlay.classList.contains("open")) closeModal(); });
  $("mTitle").addEventListener("input", () => { if($("mErr").textContent === "件名を入力してください。") $("mErr").textContent = ""; });
  $("mTitle").addEventListener("keydown", e => { if(e.key === "Enter" && !e.isComposing){ e.preventDefault(); save(); } });
  $("mStart").addEventListener("change", () => {
    // 開始を動かしたら、元の長さを保って終了も追従
    const s = toMin($("mStart").value); if(s == null) return;
    let e = toMin($("mEnd").value); if(e === 0) e = 1440;
    if(e == null || e <= s) $("mEnd").value = toInput(Math.min(s+30, 1440));
  });

  async function save(){
    if(!editing || !store) return;
    if(!$("mTitle").value.trim()){
      $("mErr").textContent = "件名を入力してください。";
      $("mTitle").focus();
      return;
    }
    const room = +mRoom.value;
    const start = toMin($("mStart").value);
    let end = toMin($("mEnd").value);
    if(start == null || end == null){ $("mErr").textContent = "開始時刻と終了時刻を入力してください。"; return; }
    if(end === 0 && start > 0) end = 1440;   // 終了 0:00 は 24:00 として扱う
    if(end <= start){ $("mErr").textContent = "終了時刻は開始時刻より後にしてください。"; return; }
    const clash = dayBookings(editing.date).find(b => b.room === room && b.id !== editing.id && b.start < end && start < b.end);
    if(clash){ $("mErr").textContent = "番号"+room+"は "+fmtMin(clash.start)+"–"+fmtMin(clash.end)+" に「"+(clash.title||"件名なし")+"」が入っています。"; return; }
    const b = {id:editing.id, place:currentPlace(), room, date:editing.date, start, end, title:$("mTitle").value.trim()};
    $("mSave").disabled = true; $("mSave").textContent = "保存中…";
    try { await store.save(b); closeModal(); }
    catch(e){
      console.error(e);
      if(e && (e.code === "conflict" || e.code === "not_found")){
        $("mErr").textContent = e.message;
        if(store.refreshAll) store.refreshAll();
      } else if(e && (e.code === "bad_request" || e.code === "storage")){
        $("mErr").textContent = e.message;
      } else if(e && e.code === "permission-denied"){
        $("mErr").textContent = "保存が拒否されました。Firebase のセキュリティルールを確認してください。";
      } else {
        $("mErr").textContent = "保存できませんでした。通信状態を確認して、もう一度お試しください。";
      }
    }
    finally { $("mSave").disabled = !store; $("mSave").textContent = "保存"; }
  }
  $("mSave").onclick = save;
  $("mDelete").onclick = async () => {
    if(!editing || !editing.id) return;
    if(!confirm("この予約を削除しますか？")) return;
    try { await store.remove(editing.id); closeModal(); }
    catch(e){ $("mErr").textContent = "削除できませんでした。もう一度お試しください。"; }
  };

  // ---------- 教室の選択肢 ----------
  (function buildPlaces(){
    const sel = $("placeSelect");
    sel.innerHTML = "";
    CFG.places.forEach((p, i) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name; if(i === 0) o.selected = true; sel.appendChild(o); });
    sel.addEventListener("change", () => {
      Object.keys(subs).forEach(k => { subs[k](); delete subs[k]; delete byMonth[k]; });
      syncSubscriptions(); renderBookings(); renderCalendar();
    });
  })();

  // ---------- トースト ----------
  let tt;
  function toast(msg){ const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => t.classList.remove("show"), 4000); }

  // ---------- 起動 ----------
  buildGrid();
  fitRows();
  renderHeader(); renderCalendar(); renderBookings();
  scroller.scrollTop = 8 * rowH();   // 初期表示は 8時〜

  let lastH = scroller.clientHeight;
  window.addEventListener("resize", () => {
    if(Math.abs(scroller.clientHeight - lastH) < 60) return;   // スマホのアドレスバー伸縮は無視
    const hourAtTop = scroller.scrollTop / rowH();
    lastH = scroller.clientHeight;
    fitRows(); renderBookings();
    scroller.scrollTop = hourAtTop * rowH();
  });
  setInterval(renderBookings, 60000);  // 現在時刻ラインの更新

  (async function initStore(){
    const hasFb = !!(CFG.firebase && CFG.firebase.apiKey && CFG.firebase.projectId);
    let mode = CFG.backend;
    if(mode === "auto"){
      if(hasFb) mode = "firebase";
      else if(CFG.gasUrl) mode = "gas";
      else if(await phpAvailable(CFG.phpUrl)) mode = "php";
      else mode = "local";
    }
    if(mode === "firebase" && !hasFb){ toast("config.js の firebase 設定が空です。この端末だけに保存します。"); mode = "local"; }
    if(mode === "gas" && !CFG.gasUrl){ toast("config.js の gasUrl が空です。この端末だけに保存します。"); mode = "local"; }
    try {
      store = mode === "firebase" ? await firebaseStore(CFG.firebase, CFG.firebaseCollection || "webbooth")
            : mode === "gas" ? remoteStore(gasBackend(CFG.gasUrl))
            : mode === "php" ? remoteStore(phpBackend(CFG.phpUrl))
            : localStore();
    } catch(e){
      console.error(e);
      toast("保存先（" + mode + "）に接続できませんでした。この端末だけに保存します。");
      store = localStore();
    }
    $("modeNote").textContent = store.shared
      ? "予約は共有されます（保存先：" + store.label + "）。"
      : "予約はこの端末のブラウザにだけ保存されます。共有するには config.js を設定してください。";
    syncSubscriptions();
    if(overlay.classList.contains("open")) $("mSave").disabled = false;
  })();
})();
