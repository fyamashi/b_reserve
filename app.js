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

  // ---------- 保存先：共有DB（なければこの端末のみ） ----------
  // Firestore（config.js に設定がある場合）
  function firestoreStore(fs){
    const col = fs.collection("bookings");
    return {
      shared:true,
      subscribeMonth(key, cb){
        const [y,m] = key.split("-").map(Number);
        const first = key+"-01", last = key+"-"+pad(new Date(y,m,0).getDate());
        return col.where("date",">=",first).where("date","<=",last).onSnapshot(
          snap => cb(snap.docs.map(d => Object.assign({id:d.id, pending:d.metadata.hasPendingWrites}, d.data()))),
          e => { console.error(e); toast("予約データを受信できませんでした。ページを再読み込みしてください。"); }
        );
      },
      async save(b){
        const ref = b.id ? col.doc(b.id) : col.doc();
        await ref.set({place:b.place, room:b.room, date:b.date, start:b.start, end:b.end, title:b.title, updatedAt:Date.now()});
      },
      async remove(id){ await col.doc(id).delete(); }
    };
  }
  function localStore(){
    let all = {};
    try { all = JSON.parse(localStorage.getItem("webbooth.bookings")||"{}") || {}; } catch(e){ all = {}; }
    const listeners = {};
    const persist = () => { try { localStorage.setItem("webbooth.bookings", JSON.stringify(all)); } catch(e){} };
    const emit = () => Object.keys(listeners).forEach(k => listeners[k].forEach(cb => cb(Object.values(all).filter(b => b.date.startsWith(k)))));
    return {
      shared:false,
      subscribeMonth(key, cb){
        (listeners[key] = listeners[key] || []).push(cb);
        cb(Object.values(all).filter(b => b.date.startsWith(key)));
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
    const b = {id:editing.id, place:$("placeSelect").value, room, date:editing.date, start, end, title:$("mTitle").value.trim()};
    $("mSave").disabled = true;
    try { await store.save(b); closeModal(); }
    catch(e){
      console.error(e);
      $("mErr").textContent = e && e.code === "permission-denied" ? "予約を保存する権限がありません。" : "保存できませんでした。もう一度お試しください。";
    }
    finally { $("mSave").disabled = !store; }
  }
  $("mSave").onclick = save;
  $("mDelete").onclick = async () => {
    if(!editing || !editing.id) return;
    if(!confirm("この予約を削除しますか？")) return;
    try { await store.remove(editing.id); closeModal(); }
    catch(e){ $("mErr").textContent = "削除できませんでした。もう一度お試しください。"; }
  };

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

  (function initStore(){
    const cfg = window.WEBBOOTH_FIREBASE_CONFIG;
    if(cfg && cfg.apiKey && window.firebase){
      try {
        if(!firebase.apps.length) firebase.initializeApp(cfg);
        store = firestoreStore(firebase.firestore());
      } catch(e){ console.error(e); store = null; }
    }
    if(!store) store = localStore();
    $("modeNote").textContent = store.shared
      ? "予約は共有されます。このページを開いている全員に同じ予約表が表示されます。"
      : "予約はこの端末のブラウザにだけ保存されます。";
    syncSubscriptions();
  })();
})();
