// ==UserScript==
// @name         YouTube 概要欄フィラー (yt-filler)
// @namespace    hwiiza.yt-filler
// @version      1.14
// @description  指定フォーマットの .txt を読み込み、YouTube Studio のタイトル/概要欄/タグを自動入力する（チャンネル非依存の汎用ツール）
// @match        https://studio.youtube.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @homepageURL  https://github.com/hwiiza/yt-filler
// @supportURL   https://github.com/hwiiza/yt-filler/issues
// @downloadURL  https://hwiiza.github.io/yt-filler.user.js
// @updateURL    https://hwiiza.github.io/yt-filler.user.js
// ==/UserScript==
(function () {
  'use strict';

  const LS_KEY = 'crimson_yt_filler_payload';
  const THUMB_KEY = 'crimson_yt_filler_thumb';   // 旧: 自動再利用用。現在は保存せず毎回選択（残骸の掃除に使用）
  const WIDTH_KEY = 'crimson_yt_filler_width';   // パネル横幅（px）を保存して次回復元
  const MIN_W = 240, MAX_W = 700;

  // GMストレージ薄ラッパ（無ければlocalStorage）
  const store = {
    get: (k) => (typeof GM_getValue === 'function') ? GM_getValue(k, '') : localStorage.getItem(k),
    set: (k, v) => (typeof GM_setValue === 'function') ? GM_setValue(k, v) : localStorage.setItem(k, v),
  };

  // ---------- パーサ（2形式対応） ----------
  // A) インライン見出し:  ==================== TITLE ====================
  // B) 罫線サンドイッチ:  ════ / TITLE（…） / ════  （見出しが別行・罫線は = か ═）
  function parse(text) {
    text = text.replace(/\r\n/g, '\n').replace(/^﻿/, '');
    const KEYS = ['TITLE', 'DESCRIPTION', 'TAGS', 'THUMBNAIL', 'VIDEO', 'NOTES', 'NOTE', 'CHANNEL'];
    const findKey = (s) => { const u = (s || '').trim().toUpperCase(); return KEYS.find(k => u.startsWith(k)) || null; };
    const buf = {};
    let cur = null, prevDivider = false;
    for (const line of text.split('\n')) {
      // 罫線のみの行（= か ═ が3つ以上・他は空白のみ）
      if (/^[\s=═]{3,}$/.test(line) && /[=═]/.test(line)) { prevDivider = true; continue; }
      // A) インライン見出し
      const inline = line.match(/^[=═]{2,}\s*(.+?)\s*[=═]{2,}\s*$/);
      if (inline) {
        const k = findKey(inline[1]);
        if (k) { cur = k; buf[k] = buf[k] || []; }
        prevDivider = false; continue;
      }
      // B) 罫線直後の既知ラベル行を見出しとみなす
      if (prevDivider) {
        prevDivider = false;
        const k = findKey(line);
        if (k) { cur = k; buf[k] = buf[k] || []; continue; }
        // 既知ラベルでなければ本文として扱う（下へ）
      }
      if (cur) buf[cur].push(line);
    }
    const get = (k) => (buf[k] ? buf[k].join('\n').replace(/^\n+|\n+$/g, '') : '');
    return {
      channel: get('CHANNEL'),
      title: get('TITLE').trim(),
      description: get('DESCRIPTION'),
      tags: get('TAGS').split(',').map(s => s.trim()).filter(Boolean),
      thumbnail: get('THUMBNAIL').trim(),
    };
  }

  // ---------- DOM ヘルパ ----------
  const isVisible = (e) => !!(e && e.getClientRects().length && e.offsetParent !== null);
  // 複数セレクタ候補から「可視」な要素を優先して返す（無ければ最初に見つかった物）
  const q = (sels) => {
    let first = null;
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (!first) first = el;
        if (isVisible(el)) return el;
      }
    }
    return first;
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 要素生成ヘルパ（innerHTML不使用＝Trusted Types環境でも安全）
  function el(tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'style') e.style.cssText = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (kids) for (const c of kids) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }

  // React/Polymer の <input>/<textarea> に確実に値を入れる（native setter + input/change）
  function setNativeValue(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getTitleBox() {
    return q(['#title-textarea #textbox', 'ytcp-social-suggestions-textbox[id="title-textarea"] #textbox', '#title #textbox']);
  }
  function getDescBox() {
    return q(['#description-textarea #textbox', 'ytcp-social-suggestions-textbox[id="description-textarea"] #textbox', '#description #textbox']);
  }
  function getTagsInput() {
    return q(['#tags-container #text-input', '#tags input#text-input', 'ytcp-form-input-container[id*="tags"] input', '#text-input.ytcp-chip-bar', 'input[aria-label*="tag" i]']);
  }

  // contenteditable に確実に入れる（Polymer の input イベントを発火）
  function setEditable(el, text) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function commitTag(input, tag) {
    input.focus();
    setNativeValue(input, '');      // 既存入力中の文字をクリア
    setNativeValue(input, tag);     // native setter で値を反映
    await sleep(60);
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    }
    await sleep(120);
  }

  // ---------- アクション ----------
  function setTitle(data, log) {
    const el = getTitleBox();
    if (!el) { log('✖ タイトル欄が見つかりません（アップロード/詳細編集画面を開いて）', true); return false; }
    setEditable(el, data.title);
    log('✔ タイトル設定: ' + data.title);
    return true;
  }
  function setDesc(data, log) {
    const el = getDescBox();
    if (!el) { log('✖ 概要欄が見つかりません（アップロード/詳細編集画面を開いて）', true); return false; }
    setEditable(el, data.description);
    log('✔ 概要欄設定: ' + data.description.length + '文字');
    return true;
  }
  async function setTags(data, log) {
    const input = getTagsInput();
    if (!input) { log('✖ タグ入力欄が見つかりません（「すべて表示」を押してタグ欄を表示して）', true); return false; }
    for (const t of data.tags) { await commitTag(input, t); }
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    log('✔ タグ設定: ' + data.tags.length + '個（反映を目視確認してください）');
    return true;
  }

  // YouTube側のサムネ用 file input を探す（自分のパネル内の入力は除外）
  function getThumbInput() {
    const sels = ['ytcp-thumbnails-compact-editor input[type="file"]', 'input#file-loader[type="file"]', 'input[type="file"][accept*="image"]', 'input[type="file"]'];
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (el.closest('#crimson-yt-panel')) continue;
        return el;
      }
    }
    return null;
  }
  // 画像File を YouTube のサムネ入力へ流し込む
  function applyThumbFile(file, log) {
    const input = getThumbInput();
    if (!input) { log('✖ サムネのファイル入力が見つかりません（詳細画面でサムネ欄を表示）', true); return false; }
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      log('✔ サムネ設定: ' + file.name + '（プレビュー反映を確認）');
      return true;
    } catch (e) { log('✖ サムネ設定失敗: ' + e.message, true); return false; }
  }
  // basename 抽出（パス表示用）
  function baseName(p) { return (p || '').trim().replace(/\\/g, '/').split('/').pop() || ''; }

  // 優先: 手動で選んだ/復元したFile → 無ければ案内（Chrome MV3ではパス自動読込不可）
  function setThumbnail(thumbFile, data, log) {
    if (thumbFile) return applyThumbFile(thumbFile, log);
    const hint = (data && data.thumbnail) ? '「' + baseName(data.thumbnail) + '」を ②サムネ画像 で選択してください' : '②サムネ画像 で画像を選択してください';
    log('✖ サムネ画像が未読込。' + hint + '（一度選べば次回以降は自動再利用）', true);
    return false;
  }
  // 対象視聴者「いいえ、子ども向けではありません」を選択
  function setNotForKids(log) {
    let el = document.querySelector('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]');
    if (!el) {
      const cands = [...document.querySelectorAll('tp-yt-paper-radio-button, ytcp-radio-button, [role="radio"]')];
      el = cands.find(c => /子ども向けではありません|子供向けではありません/.test(c.textContent || ''))
        || cands.find(c => /not made for kids|not .* for kids/i.test(c.textContent || ''));
    }
    if (!el) { log('✖ 「子ども向けではありません」が見つかりません（対象視聴者セクションを表示）', true); return false; }
    el.click();
    log('✔ 視聴者: いいえ、子ども向けではありません');
    return true;
  }

  // ---------- UI ----------
  function buildPanel() {
    if (document.getElementById('crimson-yt-panel')) return;
    const oldFab = document.getElementById('cyt-fab'); if (oldFab) oldFab.remove();

    // 右端の縦タブ（開くトリガ）
    const fab = el('button', { id: 'cyt-fab', text: '🔴 yt-filler' });
    document.body.appendChild(fab);

    const box = document.createElement('div');
    box.id = 'crimson-yt-panel';

    const head = el('div', { id: 'cyt-head' }, [
      el('b', { text: '🔴 yt-filler' }),
      el('span', { style: 'flex:1' }),
      el('button', { id: 'cyt-x', class: 'cyt-x', title: '閉じる', text: '×' }),
    ]);
    const fileInput = el('input', { id: 'cyt-file', type: 'file', accept: '.txt', style: 'display:block;margin-top:3px;width:100%;font-size:11px' });
    const label = el('label', { style: 'display:block' }, ['① txtを読込（D&D可）', fileInput]);
    const thumbInput = el('input', { id: 'cyt-thumb', type: 'file', accept: 'image/*', style: 'display:block;margin-top:3px;width:100%;font-size:11px' });
    const thumbLabel = el('label', { style: 'display:block' }, ['② サムネ画像(毎回選択・D&D可)', thumbInput]);
    const thumbPreview = el('img', { id: 'cyt-thumb-preview', alt: 'サムネプレビュー', style: 'display:none;width:100%;border-radius:5px;border:1px solid #444' });
    const infoDiv = el('div', { id: 'cyt-info', text: '未読込', style: 'font-size:11px;color:#aaa;white-space:pre-wrap;min-height:34px;background:#000;padding:5px;border-radius:5px' });
    const mkBtn = (act, txt, extra) => el('button', Object.assign({ 'data-act': act, class: 'cyt-b', text: txt }, extra ? { style: extra } : {}));
    const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:5px' }, [
      mkBtn('title', 'タイトル'), mkBtn('desc', '概要欄'), mkBtn('tags', 'タグ'),
      mkBtn('thumb', 'サムネ'), mkBtn('kids', '子供向けでない'),
      mkBtn('all', '全部設定', 'background:#c00;border-color:#c00'),
    ]);
    const logDiv = el('div', { id: 'cyt-log', style: 'flex-shrink:0;height:120px;overflow:auto;background:#000;padding:5px;border-radius:5px' });
    const bodyDiv = el('div', { id: 'cyt-body' }, [label, thumbLabel, thumbPreview, infoDiv, grid, logDiv]);
    const resizeHandle = el('div', { id: 'cyt-resize', title: 'ドラッグで幅変更' });
    box.appendChild(resizeHandle);
    box.appendChild(head);
    box.appendChild(bodyDiv);
    document.body.appendChild(box);

    // 保存済みの横幅を復元
    let panelW = 300;
    try { const w = parseInt(store.get(WIDTH_KEY), 10); if (Number.isFinite(w)) panelW = Math.max(MIN_W, Math.min(MAX_W, w)); } catch (e) {}
    box.style.width = panelW + 'px';

    if (!document.getElementById('crimson-yt-style')) {
      const style = document.createElement('style');
      style.id = 'crimson-yt-style';
      // ホストCSSとの衝突回避のため #crimson-yt-panel / #cyt-fab 配下にスコープ
      style.textContent = [
        '#cyt-fab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483646;',
        'background:#c00;color:#fff;border:1px solid #e11;border-right:none;border-radius:10px 0 0 10px;',
        'padding:12px 7px;cursor:pointer;writing-mode:vertical-rl;font:700 12px/1.4 system-ui,sans-serif;',
        'letter-spacing:.08em;box-shadow:-4px 0 16px rgba(0,0,0,.45);transition:right .22s ease}',
        '#cyt-fab:hover{background:#d00}',
        '#cyt-fab.resizing{transition:none}',
        '#crimson-yt-panel{position:fixed;top:0;right:0;height:100vh;width:300px;z-index:2147483647;',
        'background:#111;color:#eee;border-left:1px solid #e11;display:flex;flex-direction:column;',
        'transform:translateX(100%);transition:transform .22s ease;box-shadow:-12px 0 40px rgba(0,0,0,.55);',
        'font:12px/1.5 system-ui,sans-serif}',
        '#crimson-yt-panel.open{transform:translateX(0)}',
        '#crimson-yt-panel *{box-sizing:border-box}',
        '#cyt-resize{position:absolute;left:0;top:0;width:6px;height:100%;cursor:ew-resize;z-index:5}',
        '#cyt-resize:hover,#cyt-resize.active{background:rgba(225,17,17,.5)}',
        '#cyt-head{background:#c00;padding:10px 12px;font-weight:700;display:flex;align-items:center;gap:8px;flex-shrink:0}',
        '#cyt-head b{font-size:14px}',
        '#cyt-x{background:transparent;border:none;color:#fff;font-size:20px;line-height:1;padding:0 4px;cursor:pointer}',
        '#cyt-x:hover{color:#ffd}',
        '#cyt-body{flex:1;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px}',
        '#crimson-yt-panel .cyt-b{background:#222;color:#eee;border:1px solid #555;border-radius:6px;padding:8px;cursor:pointer;font-size:12px}',
        '#crimson-yt-panel .cyt-b:hover{background:#333}',
      ].join('');
      document.head.appendChild(style);
    }

    const info = box.querySelector('#cyt-info');
    const logEl = box.querySelector('#cyt-log');
    const log = (msg, err) => {
      const d = document.createElement('div');
      d.textContent = msg;
      if (err) d.style.color = '#f66';
      logEl.prepend(d);
    };

    let data = null;
    let thumbFile = null;
    let thumbURL = null;
    const preview = box.querySelector('#cyt-thumb-preview');
    const showPreview = () => {
      if (thumbURL) { URL.revokeObjectURL(thumbURL); thumbURL = null; }
      if (thumbFile) {
        thumbURL = URL.createObjectURL(thumbFile);
        preview.src = thumbURL;
        preview.style.display = 'block';
      } else {
        preview.removeAttribute('src');
        preview.style.display = 'none';
      }
    };
    const showInfo = () => {
      const lines = [];
      if (data) {
        lines.push(`Title: ${data.title}`);
        lines.push(`Desc: ${data.description.length}字 / Tags: ${data.tags.length}個`);
      }
      if (thumbFile) lines.push('Thumb: ' + thumbFile.name);
      else if (data && data.thumbnail) lines.push('Thumb: ' + baseName(data.thumbnail) + '（②で選択して下さい）');
      else lines.push('Thumb: 毎回②で選択して下さい');
      info.textContent = lines.length ? lines.join('\n') : '未読込';
      showPreview();
    };

    // txt を復元
    try {
      const saved = store.get(LS_KEY);
      if (saved) { data = JSON.parse(saved); log('（前回の読込内容を復元）'); }
    } catch (e) {}
    // サムネ画像は毎回手動選択（自動再利用しない）。旧バージョンの保存済データが残っていれば掃除
    try { store.set(THUMB_KEY, ''); } catch (e) {}
    showInfo();

    // txtファイルを読み込んでパース（input/D&D 共通）
    const loadTxtFile = (f) => {
      const r = new FileReader();
      r.onload = () => {
        try {
          data = parse(r.result);
          store.set(LS_KEY, JSON.stringify(data));
          showInfo();
          log('✔ 読込OK: ' + f.name);
        } catch (e) { log('✖ パース失敗: ' + e.message, true); }
      };
      r.readAsText(f, 'UTF-8');
    };
    // サムネ画像を取り込む（input/D&D 共通）
    const loadThumbFile = (f) => {
      thumbFile = f;
      showInfo();
      log('✔ サムネ画像: ' + f.name);
    };
    // ファイル種別で振り分け（拡張子 .txt or テキストMIME → txt、image/* → サムネ）
    const routeFile = (f) => {
      if (/\.txt$/i.test(f.name) || /^text\//.test(f.type)) loadTxtFile(f);
      else if (/^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)) loadThumbFile(f);
      else log('✖ 未対応のファイル: ' + f.name + '（.txt か画像をD&D）', true);
    };

    box.querySelector('#cyt-file').addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (f) loadTxtFile(f);
    });

    box.querySelector('#cyt-thumb').addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (f) loadThumbFile(f);
    });

    // パネルへの D&D（txt と画像の両方を受け付け、種別で自動振り分け）
    const dz = bodyDiv;
    const dzBase = dz.style.outline;
    ['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, (e) => {
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      dz.style.outline = '2px dashed #f44';
      dz.style.outlineOffset = '-4px';
    }));
    ['dragleave', 'drop'].forEach(t => dz.addEventListener(t, (e) => {
      e.preventDefault(); e.stopPropagation();
      if (t === 'dragleave' && dz.contains(e.relatedTarget)) return; // 内側要素への移動は無視
      dz.style.outline = dzBase;
    }));
    dz.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      for (const f of files) routeFile(f);
    });

    box.querySelectorAll('.cyt-b').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      // txtが要るアクションのみ事前チェック
      if ((act === 'title' || act === 'desc' || act === 'tags' || act === 'all') && !data) {
        log('先に txt を読み込んでください', true); return;
      }
      if (act === 'title') setTitle(data, log);
      else if (act === 'desc') setDesc(data, log);
      else if (act === 'tags') await setTags(data, log);
      else if (act === 'thumb') setThumbnail(thumbFile, data, log);
      else if (act === 'kids') setNotForKids(log);
      else if (act === 'all') {
        setTitle(data, log);
        await sleep(300);
        setDesc(data, log);
        await sleep(300);
        await setTags(data, log);
        await sleep(300);
        setNotForKids(log);
        if (thumbFile || (data && data.thumbnail)) { await sleep(300); setThumbnail(thumbFile, data, log); }
      }
    }));

    // 開閉（FABは常時表示のトグル。開くとパネル左端へ寄り、クリックで閉じる）
    const isOpen = () => box.classList.contains('open');
    const placeFab = () => { fab.style.right = isOpen() ? (box.offsetWidth + 'px') : '0px'; };
    const open = () => { box.classList.add('open'); placeFab(); };
    const close = () => { box.classList.remove('open'); placeFab(); };
    fab.addEventListener('click', () => { if (isOpen()) close(); else open(); });
    box.querySelector('#cyt-x').addEventListener('click', close);
    // ファイルをタブにドロップしたら開いて読込
    ['dragenter', 'dragover'].forEach(t => fab.addEventListener(t, (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    }));
    fab.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      e.preventDefault(); open();
      for (const f of files) routeFile(f);
    });

    // 横幅リサイズ（左端ハンドルをドラッグ。パネルは右寄せなので width = 画面幅 - マウスX）
    (function resize() {
      let on = false;
      resizeHandle.addEventListener('mousedown', (e) => {
        on = true; resizeHandle.classList.add('active'); fab.classList.add('resizing');
        document.body.style.userSelect = 'none'; e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!on) return;
        const w = Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - e.clientX));
        box.style.width = w + 'px';
        if (isOpen()) fab.style.right = w + 'px';
      });
      document.addEventListener('mouseup', () => {
        if (!on) return;
        on = false; resizeHandle.classList.remove('active'); fab.classList.remove('resizing');
        document.body.style.userSelect = '';
        try { store.set(WIDTH_KEY, String(parseInt(box.style.width, 10))); } catch (e) {}
      });
    })();

    close();   // デフォルトは収納（右端タブのみ表示）
  }

  // SPA対策: 冪等な init を一定間隔で呼び、UIが消えたら再注入（§2）
  const init = () => {
    if (!document.body) return;
    if (document.getElementById('crimson-yt-panel')) return;
    buildPanel();
  };
  init();
  setInterval(init, 1500);
})();
