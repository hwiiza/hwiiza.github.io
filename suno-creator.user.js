// ==UserScript==
// @name         Suno Creator
// @namespace    hwiiza.suno
// @version      0.2.7
// @description  SunoのCreate画面にパネルを表示し、JSON(1曲/配列)から曲を生成・連続生成。曲のMP3一括/個別ダウンロードも対応。
// @match        https://suno.com/*
// @match        https://www.suno.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      cdn1.suno.ai
// @connect      suno.ai
// @homepageURL  https://github.com/hwiiza/suno-creator
// @supportURL   https://github.com/hwiiza/suno-creator/issues
// @downloadURL  https://hwiiza.github.io/suno-creator.user.js
// @updateURL    https://hwiiza.github.io/suno-creator.user.js
// ==/UserScript==

(function () {
  'use strict';

  const MAX_CONCURRENT = 10;  // Premier: 同時生成は最大10曲(=20バリアント)
  const INFLIGHT_SEC = 240;   // 生成中とみなす推定時間(枠の概算。完了検知が無いため時間ベース)
  const WAIT_KEY = 'sunoCreator.waitSeconds';
  const getWait = () => { const v = parseInt(localStorage.getItem(WAIT_KEY) || '', 10); return Number.isFinite(v) && v >= 0 ? v : 60; };
  const setWait = (v) => localStorage.setItem(WAIT_KEY, String(v));
  const WIDTH_KEY = 'sunoCreator.panelWidth';
  const getWidth = () => { const v = parseInt(localStorage.getItem(WIDTH_KEY) || '', 10); return Number.isFinite(v) && v >= 300 ? v : 380; };
  const setWidthLS = (v) => localStorage.setItem(WIDTH_KEY, String(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- タブ抑制/凍結の緩和 ----
  // 最小化・バックグラウンド時、Chromeはタイマーを抑制/凍結する。無音のWebAudioを鳴らして
  // 「音声再生中」扱いにし凍結を防ぐ（完全には防げない＝可能ならウィンドウは表示のまま推奨）。
  let _keepCtx = null, _keepOsc = null;
  function keepAliveStart() {
    try {
      if (_keepCtx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      _keepCtx = new AC();
      const g = _keepCtx.createGain(); g.gain.value = 0.0001;
      _keepOsc = _keepCtx.createOscillator(); _keepOsc.frequency.value = 30;
      _keepOsc.connect(g); g.connect(_keepCtx.destination); _keepOsc.start();
      if (_keepCtx.state === 'suspended') _keepCtx.resume();
    } catch (_) {}
  }
  function keepAliveStop() {
    try { if (_keepOsc) _keepOsc.stop(); } catch (_) {}
    try { if (_keepCtx) _keepCtx.close(); } catch (_) {}
    _keepOsc = _keepCtx = null;
  }

  // ---- 保存先(File System Access API)・DL ヘルパー ----
  // 選んだフォルダのハンドルを IndexedDB に保存して次回も使う
  function idbReq(mode, fn) {
    return new Promise((res) => {
      const r = indexedDB.open('sunoCreator', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { const tx = r.result.transaction('kv', mode); const out = fn(tx.objectStore('kv')); tx.oncomplete = () => res(out ? out.result : undefined); tx.onerror = () => res(undefined); };
      r.onerror = () => res(null);
    });
  }
  const idbGet = (k) => idbReq('readonly', (s) => s.get(k));
  const idbSet = (k, v) => idbReq('readwrite', (s) => s.put(v, k));
  // フォルダの書込権限を確保(クリックのジェスチャ中に呼ぶこと)
  async function ensurePerm(h) {
    if (!h) return false;
    const opt = { mode: 'readwrite' };
    try { if ((await h.queryPermission(opt)) === 'granted') return true; return (await h.requestPermission(opt)) === 'granted'; }
    catch (_) { return false; }
  }
  async function saveToDir(dir, name, blob) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();
  }
  async function fileExistsInDir(dir, name) {
    try { await dir.getFileHandle(name, { create: false }); return true; } catch (_) { return false; }
  }
  // 今回DL分(used) と フォルダ内の既存ファイル の両方を避けた一意名（macOS/Win問わず上書き防止）
  async function freeName(dir, base, ext, used) {
    let cand = base + ext, n = 2;
    while (used.has(cand.toLowerCase()) || (dir && await fileExistsInDir(dir, cand))) cand = base + ' (' + (n++) + ')' + ext;
    return cand;
  }
  function aDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
  function fetchBlob(id) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'GET', url: 'https://cdn1.suno.ai/' + id + '.mp3', responseType: 'blob',
        onload: (r) => (r.status === 200 ? res(r.response) : rej(new Error('HTTP ' + r.status))),
        onerror: () => rej(new Error('network')), ontimeout: () => rej(new Error('timeout')),
      });
    });
  }

  // ---- DOMユーティリティ ----
  const isVisible = (el) => !!(el && el.getClientRects().length && el.offsetParent !== null);
  function firstVisible(selector) {
    for (const el of document.querySelectorAll(selector)) if (isVisible(el)) return el;
    return null;
  }
  function byText(tag, text) {
    for (const el of document.querySelectorAll(tag)) {
      if ((el.textContent || '').trim() === text && isVisible(el)) return el;
    }
    return null;
  }
  // React制御の input/textarea に値を入れる(nativeセッター + inputイベント)
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // contenteditable(Lexical等)の歌詞エディタに投入。全選択→pasteで置換(改行が保たれる)。
  function setEditableText(el, text) {
    el.focus();
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
    const dt = new DataTransfer(); dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }

  // ---- Suno UI 操作 ----
  function ensureAdvanced() { const adv = byText('button', 'Advanced'); if (adv) adv.click(); }
  function ensureMoreOptions() {
    if (firstVisible('[role="slider"][aria-label="Weirdness"]')) return;
    const mo = byText('div', 'More Options') || byText('button', 'More Options');
    if (mo) mo.click();
  }
  // 歌詞欄: 2026-06以降は contenteditable(.lyrics-editor-content)。旧textareaもフォールバックで対応。
  function getLyrics() { return document.querySelector('.lyrics-editor-content') || document.querySelector('[aria-label="Lyrics editor"]') || firstVisible('textarea[data-testid="lyrics-textarea"]'); }
  function getStyle() {
    const w = document.querySelector('[data-testid="create-form-styles-wrapper"] textarea');
    if (w && isVisible(w)) return w;
    for (const t of document.querySelectorAll('textarea:not([data-testid="lyrics-textarea"])')) if (isVisible(t)) return t;
    return null;
  }
  function getTitle() { return firstVisible('input[placeholder="Song Title (Optional)"]'); }
  function getCreate() { return firstVisible('button[aria-label="Create song"]') || byText('button', 'Create'); }
  function setVocal(gender) {
    const label = gender === 'female' ? 'Female' : gender === 'male' ? 'Male' : null;
    if (!label) return;
    const btn = byText('button', label);
    if (btn && btn.getAttribute('data-selected') !== 'true') btn.click();
  }
  // カスタムスライダー(role=slider)を矢印キーで目標値へ。keyCode必須＋各押下に小休止。
  async function setSlider(ariaLabel, target) {
    const s = firstVisible(`[role="slider"][aria-label="${ariaLabel}"]`);
    if (!s) return false;
    target = Math.max(0, Math.min(100, Math.round(target)));
    s.focus();
    for (let k = 0; k < 220; k++) {
      const now = Number(s.getAttribute('aria-valuenow'));
      if (Number.isNaN(now) || now === target) break;
      const right = now < target;
      s.dispatchEvent(new KeyboardEvent('keydown', { key: right ? 'ArrowRight' : 'ArrowLeft', code: right ? 'ArrowRight' : 'ArrowLeft', keyCode: right ? 39 : 37, which: right ? 39 : 37, bubbles: true, cancelable: true }));
      await sleep(32);
      if (Number(s.getAttribute('aria-valuenow')) === now) break; // これ以上動かなければ終了
    }
    return Number(s.getAttribute('aria-valuenow')) === target;
  }

  async function fillSong(song, log) {
    ensureAdvanced();
    await sleep(800);
    if (song.instrumental) {
      const inst = firstVisible('button[aria-label*="instrumental only" i]') || byText('button', 'Instrumental');
      if (inst && inst.getAttribute('data-selected') !== 'true') inst.click();
      await sleep(300);
    } else if (song.lyrics) {
      const lyr = getLyrics();
      if (!lyr) { log('⚠ 歌詞欄が見つからない'); }
      else if (lyr.isContentEditable) {
        lyr.focus(); lyr.click(); await sleep(150);
        setEditableText(lyr, song.lyrics); await sleep(200);
        if (!(lyr.innerText || '').trim()) { setEditableText(lyr, song.lyrics); await sleep(150); }  // 初回失敗時リトライ
      } else { setNativeValue(lyr, song.lyrics); }
    }
    if (song.style) { const st = getStyle(); if (st) setNativeValue(st, song.style); else log('⚠ スタイル欄が見つからない'); }
    if (song.title) { const ti = getTitle(); if (ti) setNativeValue(ti, song.title); }
    const needMore = song.exclude || (song.vocal && song.vocal !== 'auto') || song.weirdness != null || song.styleInfluence != null;
    if (needMore) {
      ensureMoreOptions();
      await sleep(500);
      if (song.exclude) { const ex = firstVisible('input[placeholder="Exclude styles"]'); if (ex) setNativeValue(ex, song.exclude); }
      if (song.vocal && song.vocal !== 'auto') setVocal(song.vocal);
      if (song.weirdness != null && !(await setSlider('Weirdness', Number(song.weirdness)))) log('⚠ Weirdness設定に失敗');
      if (song.styleInfluence != null && !(await setSlider('Style Influence', Number(song.styleInfluence)))) log('⚠ Style Influence設定に失敗');
    }
  }

  function validate(s) {
    if (!s || typeof s !== 'object') return 'オブジェクトではありません';
    if (!(s.style || s.lyrics || s.instrumental)) return 'style/lyrics/instrumental のいずれか必須';
    if (s.vocal && !['male', 'female', 'auto'].includes(s.vocal)) return 'vocal は male|female|auto';
    return null;
  }

  async function generateOne(song, log) {
    await fillSong(song, log);
    await sleep(400);
    const btn = getCreate();
    if (!btn) { log('✖ 生成ボタンが見つからない'); return false; }
    btn.click();
    log('  ✅ 投入: ' + (song.title || song.style || '曲'));
    return true;
  }

  // ---- UI (SPA対策: 無ければ作る／消えたら再注入) ----
  const PANEL_ID = 'suno-creator-panel';
  const FAB_ID = 'suno-creator-fab';

  function init() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    const oldFab = document.getElementById(FAB_ID); if (oldFab) oldFab.remove();

    let songs = [];     // 読み込んだ曲
    let statuses = [];  // '' | submitting | submitted | failed
    let sel = -1;       // 選択中index
    let busy = false;
    const BADGE = { submitting: '投入中', submitted: '投入済', failed: '失敗' };

    // 開閉トグル(右端タブ)
    const fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.textContent = '♪ Suno Creator';
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
    <style>
      #${FAB_ID}{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483646;
        background:#252529;color:#f7f4ef;border:1px solid #2e2e34;border-right:none;border-radius:10px 0 0 10px;
        padding:12px 7px;cursor:pointer;writing-mode:vertical-rl;font-size:12px;letter-spacing:.1em;
        font-family:"Neue Montreal",system-ui,"Segoe UI",sans-serif;box-shadow:-4px 0 16px rgba(0,0,0,.4);transition:right .22s ease;}
      #${FAB_ID}:hover{background:#303035;}
      #${PANEL_ID}{position:fixed;top:0;right:0;height:100vh;width:380px;z-index:2147483647;
        background:#101012;color:#f7f4ef;border-left:1px solid #2e2e34;display:flex;flex-direction:column;
        transform:translateX(100%);transition:transform .22s ease;box-shadow:-12px 0 40px rgba(0,0,0,.55);
        font-family:"Neue Montreal",system-ui,"Segoe UI","Yu Gothic UI",sans-serif;font-size:13px;}
      #${PANEL_ID}.open{transform:translateX(0);}
      #${PANEL_ID} *{box-sizing:border-box;}
      #${PANEL_ID} .resize{position:absolute;left:0;top:0;width:7px;height:100%;cursor:ew-resize;z-index:12;}
      #${PANEL_ID} .resize:hover{background:linear-gradient(to right,#6c8cff66,transparent);}
      #${PANEL_ID} .dz{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
        background:rgba(16,16,18,.88);border:2px dashed #6c8cff;border-radius:12px;z-index:10;
        color:#f7f4ef;font-size:14px;pointer-events:none;}
      #${PANEL_ID} .hd{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #2e2e34;flex-shrink:0;}
      #${PANEL_ID} .hd b{font-size:14px;letter-spacing:.02em;}
      #${PANEL_ID} .settings{padding:11px 14px;border-bottom:1px solid #2e2e34;background:#16161b;flex-shrink:0;}
      #${PANEL_ID} .settings label{font-size:12px;color:#f7f4ef;display:flex;align-items:center;gap:8px;}
      #${PANEL_ID} .settings input{width:80px;background:#0b0b0d;color:#f7f4ef;border:1px solid #2e2e34;border-radius:7px;padding:5px 8px;font-family:inherit;font-size:12px;outline:none;}
      #${PANEL_ID} .bd{flex:1;display:flex;flex-direction:column;min-height:0;padding:12px 14px;gap:10px;}
      #${PANEL_ID} .row{display:flex;gap:8px;align-items:center;}
      #${PANEL_ID} button{background:#252529;color:#f7f4ef;border:1px solid #2e2e34;border-radius:999px;
        padding:6px 14px;cursor:pointer;font-size:12px;font-family:inherit;}
      #${PANEL_ID} button:hover{background:#303035;}
      #${PANEL_ID} button.primary{background:#f7f4ef;border-color:#f7f4ef;color:#101012;font-weight:600;}
      #${PANEL_ID} button.primary:hover{background:#fff;}
      #${PANEL_ID} button:disabled{opacity:.45;cursor:not-allowed;}
      #${PANEL_ID} .x{background:transparent;border:none;color:#8a8a90;font-size:18px;padding:0 4px;line-height:1;}
      #${PANEL_ID} .x:hover{color:#f7f4ef;background:transparent;}
      #${PANEL_ID} .cnt{color:#8a8a90;font-size:11px;}
      #${PANEL_ID} .list{flex-shrink:0;max-height:34vh;overflow:auto;border:1px solid #2e2e34;border-radius:9px;}
      #${PANEL_ID} .empty{color:#8a8a90;font-size:11px;padding:16px;text-align:center;}
      #${PANEL_ID} .item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2e2e34;cursor:pointer;}
      #${PANEL_ID} .item:last-child{border-bottom:none;}
      #${PANEL_ID} .item:hover{background:#1a1a1d;}
      #${PANEL_ID} .item.sel{background:#252529;}
      #${PANEL_ID} .item .ix{color:#8a8a90;width:16px;text-align:right;font-size:11px;}
      #${PANEL_ID} .item .mt{flex:1;min-width:0;}
      #${PANEL_ID} .item .t{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      #${PANEL_ID} .item .s{font-size:10px;color:#8a8a90;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      #${PANEL_ID} .bdg{font-size:10px;padding:1px 8px;border-radius:999px;border:1px solid #2e2e34;color:#8a8a90;white-space:nowrap;}
      #${PANEL_ID} .bdg.invalid,#${PANEL_ID} .bdg.failed{color:#ff8a8a;border-color:#5a2a2a;}
      #${PANEL_ID} .bdg.submitting{color:#9ec5ff;border-color:#2a4a6b;}
      #${PANEL_ID} .bdg.submitted{color:#8fe3b0;border-color:#2a5a42;}
      #${PANEL_ID} .detail{flex:1;min-height:120px;overflow:auto;border:1px solid #2e2e34;border-radius:9px;padding:11px;}
      #${PANEL_ID} .detail .ph{color:#8a8a90;font-size:12px;text-align:center;padding:20px 0;}
      #${PANEL_ID} .fld{margin-bottom:9px;}
      #${PANEL_ID} .fld label{display:block;font-size:10px;color:#8a8a90;margin-bottom:3px;}
      #${PANEL_ID} input[type=text],#${PANEL_ID} textarea,#${PANEL_ID} select{width:100%;background:#0b0b0d;color:#f7f4ef;
        border:1px solid #2e2e34;border-radius:7px;padding:7px 9px;font-family:inherit;font-size:12px;outline:none;}
      #${PANEL_ID} input:focus,#${PANEL_ID} textarea:focus,#${PANEL_ID} select:focus{border-color:#f7f4ef;}
      #${PANEL_ID} textarea{height:130px;resize:vertical;font-family:Consolas,monospace;line-height:1.45;}
      #${PANEL_ID} .two{display:flex;gap:8px;}
      #${PANEL_ID} .two>div{flex:1;}
      #${PANEL_ID} .chk{display:flex;align-items:center;gap:6px;margin-bottom:9px;}
      #${PANEL_ID} .chk input{width:15px;height:15px;accent-color:#f7f4ef;}
      #${PANEL_ID} .chk label{margin:0;color:#f7f4ef;font-size:12px;}
      #${PANEL_ID} input[type=range]{width:100%;accent-color:#f7f4ef;margin-top:2px;}
      #${PANEL_ID} .seclabel{font-size:11px;color:#8a8a90;letter-spacing:.05em;margin:2px 0 -4px;text-transform:uppercase;}
      #${PANEL_ID} .list{background:#0b0b0d;}
      #${PANEL_ID} .detail{background:#16161b;}
      #${PANEL_ID} .detail .dttl{font-size:12px;font-weight:600;color:#f7f4ef;margin-bottom:9px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      #${PANEL_ID} .log{flex-shrink:0;height:74px;overflow:auto;background:#0b0b0d;border:1px solid #2e2e34;border-radius:7px;
        padding:6px 8px;font-family:Consolas,monospace;font-size:11px;color:#8a8a90;white-space:pre-wrap;}
      #${PANEL_ID} .tab{background:transparent;border:1px solid #2e2e34;color:#8a8a90;border-radius:999px;padding:3px 12px;font-size:12px;}
      #${PANEL_ID} .tab.active{background:#252529;color:#f7f4ef;}
      #${PANEL_ID} .view{flex:1;display:flex;flex-direction:column;min-height:0;gap:10px;}
      #${PANEL_ID} .dllist{flex:1;max-height:none;}
      #${PANEL_ID} .bdg.downloading{color:#9ec5ff;border-color:#2a4a6b;}
      #${PANEL_ID} .bdg.done{color:#8fe3b0;border-color:#2a5a42;}
    </style>
    <div class="resize" id="sc-resize" title="ドラッグで横幅調整"></div>
    <div class="hd"><b>Suno Creator</b>
      <button id="sc-tab-create" class="tab active">作成</button>
      <button id="sc-tab-dl" class="tab">DL</button>
      <span style="flex:1"></span>
      <button id="sc-gear" class="x" title="設定">⚙</button>
      <button id="sc-x" class="x" title="閉じる">×</button></div>
    <div id="sc-settings" class="settings" style="display:none;">
      <label>次の曲まで待機（秒）<input type="number" id="sc-wait" min="0" step="5"></label>
      <div class="cnt" style="margin-top:5px;">Premier: 同時生成は最大${MAX_CONCURRENT}曲。超過分は枠が空くまで待機して投入。</div>
    </div>
    <div class="bd">
      <div id="sc-view-create" class="view">
        <div class="row">
          <button id="sc-file">ファイル読込</button>
          <span style="flex:1"></span>
          <button id="sc-run" class="primary">連続生成（全部）</button>
        </div>
        <div class="seclabel">📋 曲リスト <span class="cnt" id="sc-count">0曲</span></div>
        <div class="list" id="sc-list"><div class="empty">「ファイル読込」でJSON(1曲/配列)を選択</div></div>
        <div class="seclabel">⚙ 詳細（選択中の曲）</div>
        <div class="detail" id="sc-detail"><div class="ph">↑ リストから曲を選択すると内容を表示</div></div>
        <input id="sc-fileinput" type="file" accept=".json,application/json" style="display:none" />
      </div>
      <div id="sc-view-dl" class="view" style="display:none;">
        <div class="row">
          <button id="sc-lib">ライブラリ読込</button>
          <span style="flex:1"></span>
          <button id="sc-dlsel" class="primary">選択をDL</button>
        </div>
        <div class="seclabel">⬇ ダウンロード <span class="cnt" id="sc-libcount">0曲</span></div>
        <div class="row" style="font-size:11px;">
          <span class="cnt">保存先:</span>
          <span id="sc-dldir" class="cnt" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f7f4ef;">ダウンロードフォルダ</span>
          <button id="sc-dirpick" style="padding:3px 10px;">変更</button>
          <button id="sc-dirclear" style="padding:3px 10px;">既定</button>
        </div>
        <label class="cnt" style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:-2px 0;"><input type="checkbox" id="sc-dlall" style="width:14px;height:14px;accent-color:#f7f4ef;"> 全選択</label>
        <div class="list dllist" id="sc-dllist"><div class="empty">「ライブラリ読込」でワークスペースの曲一覧を取得</div></div>
      </div>
      <div class="log" id="sc-log">JSONを読み込み→「連続生成（全部）」/ 個別生成。「DL」タブで曲のMP3を一括/個別ダウンロード。</div>
    </div>
    <div id="sc-dz" class="dz">📂 JSONをドロップして読み込み</div>`;
    document.body.appendChild(panel);

    const $ = (id) => panel.querySelector(id);
    const logEl = $('#sc-log');
    const log = (m) => { logEl.textContent += '\n' + m; logEl.scrollTop = logEl.scrollHeight; };

    // 横幅(記憶値を適用)
    panel.style.width = getWidth() + 'px';

    // 開閉(FABは常時表示でトグル。開いている時はパネル左端の外側に出す)
    let isOpen = false;
    const applyOpen = () => {
      panel.style.transform = isOpen ? 'translateX(0)' : 'translateX(100%)';
      fab.style.right = isOpen ? (panel.offsetWidth + 'px') : '0';
    };
    const openPanel = () => { isOpen = true; applyOpen(); };
    const closePanel = () => { isOpen = false; applyOpen(); };
    const toggle = () => { isOpen = !isOpen; applyOpen(); };
    fab.addEventListener('click', toggle);
    $('#sc-x').addEventListener('click', closePanel);

    // 横幅リサイズ(左端ハンドルをドラッグ)
    (function () {
      const h = $('#sc-resize'); let on = false;
      h.addEventListener('mousedown', (e) => { on = true; e.preventDefault(); });
      window.addEventListener('mousemove', (e) => {
        if (!on) return;
        const w = Math.max(300, Math.min(window.innerWidth - 20, window.innerWidth - e.clientX));
        panel.style.width = w + 'px';
        if (isOpen) fab.style.right = w + 'px';
      });
      window.addEventListener('mouseup', () => { if (on) { on = false; setWidthLS(parseInt(panel.style.width, 10) || 380); } });
    })();

    // 設定(歯車): 待機秒数
    $('#sc-gear').addEventListener('click', () => {
      const s = $('#sc-settings');
      const show = s.style.display === 'none';
      s.style.display = show ? 'block' : 'none';
      if (show) $('#sc-wait').value = getWait();
    });
    $('#sc-wait').addEventListener('change', () => {
      let v = parseInt($('#sc-wait').value, 10);
      if (!Number.isFinite(v) || v < 0) v = 60;
      setWait(v); $('#sc-wait').value = v; log('待機時間: ' + v + '秒');
    });

    // ---- リスト ----
    function renderList() {
      $('#sc-count').textContent = songs.length + '曲';
      const el = $('#sc-list');
      if (!songs.length) { el.innerHTML = '<div class="empty">「ファイル読込」でJSON(1曲/配列)を選択</div>'; return; }
      el.innerHTML = '';
      songs.forEach((s, i) => {
        const err = validate(s), st = statuses[i] || '';
        const it = document.createElement('div');
        it.className = 'item' + (i === sel ? ' sel' : '');
        it.innerHTML =
          '<span class="ix">' + (i + 1) + '</span>' +
          '<div class="mt"><div class="t"></div><div class="s"></div></div>' +
          (err ? '<span class="bdg invalid">要確認</span>' : (st ? '<span class="bdg ' + st + '">' + (BADGE[st] || st) + '</span>' : ''));
        it.querySelector('.t').textContent = s.title || '(無題・自動命名)';
        it.querySelector('.s').textContent = (s.instrumental ? '[inst] ' : '') + (s.style || '(スタイル未設定)');
        it.addEventListener('click', () => select(i));
        el.appendChild(it);
      });
    }

    // ---- 詳細(選択曲) ----
    function renderDetail() {
      const el = $('#sc-detail');
      if (sel < 0 || !songs[sel]) { el.innerHTML = '<div class="ph">↑ リストから曲を選択すると内容を表示</div>'; return; }
      const s = songs[sel];
      const w = s.weirdness != null ? Number(s.weirdness) : 50;
      const si = s.styleInfluence != null ? Number(s.styleInfluence) : 50;
      el.innerHTML = `
        <div class="row" style="margin-bottom:11px;">
          <button id="d-gen" class="primary" style="flex:1;">この曲を生成</button>
          <button id="d-fill" title="生成せずフォームに入力だけ（テスト用）">入力のみ</button>
        </div>
        <div class="dttl" id="d-head"></div>
        <div class="fld"><label>Title</label><input type="text" id="d-title"></div>
        <div class="fld"><label>Style</label><input type="text" id="d-style"></div>
        <div class="chk"><input type="checkbox" id="d-inst"><label for="d-inst">Instrumental（歌なし）</label></div>
        <div class="fld" id="d-lyr-wrap"><label>Lyrics</label><textarea id="d-lyrics"></textarea></div>
        <div class="two">
          <div class="fld"><label>Vocal</label><select id="d-vocal">
            <option value="auto">Auto</option><option value="female">Female</option><option value="male">Male</option></select></div>
          <div class="fld"><label>Exclude</label><input type="text" id="d-exclude"></div>
        </div>
        <div class="two">
          <div class="fld"><label>Weirdness <span id="d-wv">${w}</span></label><input type="range" id="d-weird" min="0" max="100" value="${w}"></div>
          <div class="fld"><label>Style Influence <span id="d-sv">${si}</span></label><input type="range" id="d-sinf" min="0" max="100" value="${si}"></div>
        </div>`;
      $('#d-title').value = s.title || '';
      $('#d-style').value = s.style || '';
      $('#d-exclude').value = s.exclude || '';
      $('#d-lyrics').value = s.lyrics || '';
      $('#d-inst').checked = !!s.instrumental;
      $('#d-vocal').value = ['male', 'female', 'auto'].includes(s.vocal) ? s.vocal : 'auto';
      $('#d-head').textContent = s.title || '(無題・自動命名)';
      function syncInst() { const on = $('#d-inst').checked; $('#d-lyrics').disabled = on; $('#d-lyr-wrap').style.opacity = on ? .4 : 1; }
      syncInst();
      const upd = () => {
        s.title = $('#d-title').value; s.style = $('#d-style').value; s.exclude = $('#d-exclude').value;
        s.lyrics = $('#d-lyrics').value; s.instrumental = $('#d-inst').checked; s.vocal = $('#d-vocal').value;
        s.weirdness = Number($('#d-weird').value); s.styleInfluence = Number($('#d-sinf').value);
        $('#d-head').textContent = s.title || '(無題・自動命名)';
        renderList();
      };
      ['d-title', 'd-style', 'd-exclude', 'd-lyrics', 'd-vocal'].forEach((id) => $('#' + id).addEventListener('input', upd));
      $('#d-weird').addEventListener('input', () => { $('#d-wv').textContent = $('#d-weird').value; upd(); });
      $('#d-sinf').addEventListener('input', () => { $('#d-sv').textContent = $('#d-sinf').value; upd(); });
      $('#d-inst').addEventListener('change', () => { upd(); syncInst(); });
      $('#d-gen').addEventListener('click', () => genIndex(sel));
      $('#d-fill').addEventListener('click', () => fillOnly(sel));
    }

    function select(i) { sel = i; renderList(); renderDetail(); }
    function setStatus(i, st) { statuses[i] = st; renderList(); }

    function loadData(data) {
      songs = Array.isArray(data) ? data : [data];
      statuses = songs.map(() => '');
      sel = songs.length ? 0 : -1;
      renderList(); renderDetail();
    }

    // ファイル(File)を読んでリストへ。ファイル選択・D&D共通。
    function loadFromFile(f) {
      if (!f) return;
      if (!/\.json$/i.test(f.name)) { log('✖ JSONファイルを指定してください: ' + f.name); return; }
      const rd = new FileReader();
      rd.onload = () => {
        const txt = String(rd.result).replace(/^﻿/, '').trim();
        try { loadData(JSON.parse(txt)); log('📂 読込: ' + f.name + '（' + songs.length + '曲）'); }
        catch (err) { log('✖ JSON不正: ' + err.message); }
      };
      rd.onerror = () => log('✖ 読込失敗');
      rd.readAsText(f, 'utf-8');
    }

    async function genIndex(i) {
      if (busy) return;
      const s = songs[i], err = validate(s);
      if (err) { log(`✖ #${i + 1}: ${err}`); return; }
      busy = true; $('#sc-run').disabled = true; keepAliveStart();
      setStatus(i, 'submitting'); log('生成: ' + (s.title || '#' + (i + 1)));
      try { const ok = await generateOne(s, log); setStatus(i, ok ? 'submitted' : 'failed'); }
      catch (e) { setStatus(i, 'failed'); log('✖ ' + e.message); }
      finally { keepAliveStop(); busy = false; $('#sc-run').disabled = false; }
    }

    // 生成せずフォームに入力だけ（lyrics反映などのテスト用）
    async function fillOnly(i) {
      if (busy) return;
      const s = songs[i], err = validate(s);
      if (err) { log(`✖ #${i + 1}: ${err}`); return; }
      busy = true; $('#sc-run').disabled = true;
      log('入力のみ（生成しない）: ' + (s.title || '#' + (i + 1)));
      try { await fillSong(s, log); log('✅ 入力完了（Createは押していません。Suno画面で反映を確認）'); }
      catch (e) { log('✖ ' + e.message); }
      finally { busy = false; $('#sc-run').disabled = false; }
    }

    // ---- ハンドラ ----
    $('#sc-file').addEventListener('click', () => $('#sc-fileinput').click());
    $('#sc-fileinput').addEventListener('change', (e) => { loadFromFile(e.target.files && e.target.files[0]); e.target.value = ''; });

    // ---- ドラッグ&ドロップ(JSON) ----
    const dz = $('#sc-dz');
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const pickJson = (e) => [...(e.dataTransfer.files || [])].find((x) => /\.json$/i.test(x.name)) || (e.dataTransfer.files || [])[0];
    let dragDepth = 0;
    ['dragenter', 'dragover'].forEach((ev) => panel.addEventListener(ev, (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      if (ev === 'dragenter') dragDepth++;
      dz.style.display = 'flex';
    }));
    panel.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dz.style.display = 'none'; } });
    panel.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; dz.style.display = 'none';
      loadFromFile(pickJson(e));
    });
    // 右タブ(FAB)にドロップ → 開いて読込
    ['dragenter', 'dragover'].forEach((ev) => fab.addEventListener(ev, (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }));
    fab.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); openPanel(); loadFromFile(pickJson(e)); });
    $('#sc-run').addEventListener('click', async () => {
      if (busy) return;
      if (!songs.length) { log('曲がありません。「ファイル読込」してください。'); return; }
      for (let i = 0; i < songs.length; i++) { const e = validate(songs[i]); if (e) { log(`✖ #${i + 1}: ${e}`); return; } }
      const wait = getWait();
      const inflight = [];   // 投入時刻(直近INFLIGHT_SECを生成中とみなす)
      busy = true; $('#sc-run').disabled = true; keepAliveStart();
      log(`— ${songs.length}曲 連続生成（間隔${wait}秒 / 同時上限${MAX_CONCURRENT}曲）—`);
      log('※ 生成中はChromeを最小化しないでください（ブラウザがタイマーを止めます）');
      try {
        for (let i = 0; i < songs.length; i++) {
          // 同時生成が上限なら枠が空く(推定)まで待機
          while (inflight.filter((t) => Date.now() - t < INFLIGHT_SEC * 1000).length >= MAX_CONCURRENT) {
            log(`生成中が上限(${MAX_CONCURRENT}曲)。${wait}秒待機して再確認...`);
            await sleep(wait * 1000);
          }
          log(`[${i + 1}/${songs.length}] ${songs[i].title || ''}`);
          setStatus(i, 'submitting');
          const ok = await generateOne(songs[i], log);
          setStatus(i, ok ? 'submitted' : 'failed');
          inflight.push(Date.now());
          if (i < songs.length - 1) await sleep(wait * 1000);
        }
        log('✅ 完了（Suno側で生成中）');
      } catch (e) { log('✖ ' + e.message); }
      finally { keepAliveStop(); busy = false; $('#sc-run').disabled = false; }
    });

    // ===== タブ切替 =====
    function showTab(which) {
      const c = which === 'create';
      $('#sc-tab-create').classList.toggle('active', c);
      $('#sc-tab-dl').classList.toggle('active', !c);
      $('#sc-view-create').style.display = c ? 'flex' : 'none';
      $('#sc-view-dl').style.display = c ? 'none' : 'flex';
    }
    $('#sc-tab-create').addEventListener('click', () => showTab('create'));
    $('#sc-tab-dl').addEventListener('click', () => showTab('dl'));

    // ===== ダウンロード（曲のMP3） =====
    let clips = [], dlChecked = [], dlStatus = [], dirHandle = null;  // dirHandle=保存先フォルダ(未設定=DLフォルダ)
    const DLBADGE = { downloading: 'DL中', done: '完了', failed: '失敗' };
    const sanitize = (n) => (n || 'untitled').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'untitled';

    // ワークスペース(仮想スクロール)を下まで送りながら曲を全件収集
    // ※SunoのUI変更で曲は /song/<id> リンクでなくなった→カバー画像URL(cdn2.suno.ai/image_<id>)からid抽出。
    //   その<id>は音源 cdn1.suno.ai/<id>.mp3 と一致。タイトルはカードの先頭テキスト行。
    async function scrapeLibrary() {
      const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
      const map = new Map();
      const grab = () => {
        const scope = document.querySelector('.clip-browser-list-scroller') || document;
        // 各曲カードは「More options」ボタンを1つ持つ。そこを起点にカバー画像(uuid)を含む祖先=カードを特定。
        scope.querySelectorAll('button[aria-label="More options"]').forEach((btn) => {
          let card = btn, img = null;
          for (let u = 0; u < 12 && card.parentElement; u++) {
            card = card.parentElement;
            const im = card.querySelector('img');
            if (im && UUID.test(im.getAttribute('src') || im.getAttribute('data-src') || im.currentSrc || '')) { img = im; break; }
          }
          if (!img) return;
          const id = (img.getAttribute('src') || img.getAttribute('data-src') || img.currentSrc || '').match(UUID)[1];
          if (map.has(id)) return;
          const lines = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
          const title = (lines.find((l) => !/^\d{1,2}:\d{2}$/.test(l) && !/^v\d/i.test(l)) || lines[0] || '').slice(0, 80);
          map.set(id, { id, title });
        });
      };
      grab();
      const sc = document.querySelector('.clip-browser-list-scroller');
      if (sc) {
        let stale = 0;
        for (let i = 0; i < 250 && stale < 4; i++) {
          const before = map.size;
          sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + sc.clientHeight * 0.85);
          await sleep(450);
          grab();
          const bottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5;
          if (map.size === before) stale++; else stale = 0;
          if (bottom && map.size === before) break;
        }
        sc.scrollTop = 0;          // 収集後は先頭へ戻す
        await sleep(150);
      }
      return [...map.values()];
    }

    function renderDlList() {
      const n = dlChecked.filter(Boolean).length;
      $('#sc-libcount').textContent = clips.length + '曲' + (n ? '／選択' + n : '');
      $('#sc-dlall').checked = clips.length > 0 && n === clips.length;
      const el = $('#sc-dllist');
      if (!clips.length) { el.innerHTML = '<div class="empty">「ライブラリ読込」でワークスペースの曲一覧を取得</div>'; return; }
      el.innerHTML = '';
      clips.forEach((c, i) => {
        const st = dlStatus[i] || '';
        const it = document.createElement('div');
        it.className = 'item';
        it.innerHTML =
          '<input type="checkbox" data-chk="' + i + '"' + (dlChecked[i] ? ' checked' : '') + ' style="width:14px;height:14px;accent-color:#f7f4ef;">' +
          '<span class="ix">' + (i + 1) + '</span>' +
          '<div class="mt"><div class="t"></div><div class="s">' + c.id.slice(0, 8) + '</div></div>' +
          (st ? '<span class="bdg ' + st + '">' + (DLBADGE[st] || st) + '</span>' : '') +
          '<button data-dl="' + i + '" style="padding:3px 10px;">DL</button>';
        it.querySelector('.t').textContent = c.title || '(無題)';
        it.querySelector('[data-chk]').addEventListener('change', (e) => { dlChecked[i] = e.target.checked; renderDlList(); });
        it.querySelector('[data-dl]').addEventListener('click', () => downloadIdx([i]));
        el.appendChild(it);
      });
    }

    function updateDirLabel() {
      $('#sc-dldir').textContent = dirHandle ? ('📁 ' + dirHandle.name) : 'ダウンロードフォルダ';
    }

    async function downloadIdx(indices) {
      if (busy) return;
      const list = indices.filter((i) => clips[i]);
      if (!list.length) return;
      busy = true; $('#sc-dlsel').disabled = true; $('#sc-lib').disabled = true; keepAliveStart();
      // フォルダ指定があれば権限確保(クリックのジェスチャ中に確認)。無理ならDLフォルダへ。
      let useDir = false;
      if (dirHandle) { useDir = await ensurePerm(dirHandle); if (!useDir) log('⚠ フォルダ権限なし→ダウンロードフォルダに保存'); }
      const dest = useDir ? ('📁 ' + dirHandle.name) : 'ダウンロードフォルダ';
      const used = new Set();
      log('— DL ' + list.length + '曲 → ' + dest + ' —');
      for (const i of list) {
        const c = clips[i];
        const base = sanitize(c.title || c.id);
        let name;
        if (useDir) { name = await freeName(dirHandle, base, '.mp3', used); }   // 既存ファイルも避けて連番
        else { name = base + '.mp3'; let k = 2; while (used.has(name.toLowerCase())) name = base + ' (' + (k++) + ').mp3'; }  // DLフォルダはブラウザが自動連番
        used.add(name.toLowerCase());
        dlStatus[i] = 'downloading'; renderDlList();
        try {
          const blob = await fetchBlob(c.id);
          if (useDir) await saveToDir(dirHandle, name, blob); else aDownload(blob, name);
          dlStatus[i] = 'done'; log('  ✅ ' + name);
        } catch (e) { dlStatus[i] = 'failed'; log('  ✖ ' + name + ' — ' + e.message); }
        renderDlList();
        await sleep(300);
      }
      keepAliveStop();
      busy = false; $('#sc-dlsel').disabled = false; $('#sc-lib').disabled = false;
      log('✅ DL完了');
    }

    $('#sc-lib').addEventListener('click', async () => {
      if (busy) return;
      busy = true; $('#sc-lib').disabled = true; log('ライブラリ読込中...');
      try {
        clips = await scrapeLibrary();
        dlChecked = clips.map(() => true); dlStatus = clips.map(() => '');
        renderDlList(); log('📚 ' + clips.length + '曲 取得');
      } catch (e) { log('✖ ' + e.message); }
      finally { busy = false; $('#sc-lib').disabled = false; }
    });
    $('#sc-dlall').addEventListener('change', (e) => { dlChecked = clips.map(() => e.target.checked); renderDlList(); });
    $('#sc-dlsel').addEventListener('click', () => {
      const idx = clips.map((_, i) => i).filter((i) => dlChecked[i]);
      if (!idx.length) { log('DLする曲が選択されていません'); return; }
      downloadIdx(idx);
    });

    // 保存先フォルダの選択・解除
    $('#sc-dirpick').addEventListener('click', async () => {
      if (!window.showDirectoryPicker) { log('このブラウザはフォルダ選択に非対応（Chrome/Edge推奨）。DLフォルダに保存します。'); return; }
      try {
        const h = await window.showDirectoryPicker({ id: 'sunoCreatorDl', mode: 'readwrite' });
        dirHandle = h; await idbSet('dlDir', h); updateDirLabel(); log('保存先: ' + h.name);
      } catch (_) { /* キャンセル */ }
    });
    $('#sc-dirclear').addEventListener('click', async () => {
      dirHandle = null; await idbSet('dlDir', null); updateDirLabel(); log('保存先: ダウンロードフォルダ');
    });
    // 前回選んだフォルダを復元(権限は次回DL時に確認)
    (async () => { try { const h = await idbGet('dlDir'); if (h) { dirHandle = h; updateDirLabel(); } } catch (_) {} })();

    console.log('[Suno Creator] ready');
  } // end init

  init();
  // SunoはSPA。マウント後/ページ遷移でUIが無くなったら作り直す
  setInterval(() => { if (!document.getElementById(PANEL_ID)) init(); }, 1500);
})();
