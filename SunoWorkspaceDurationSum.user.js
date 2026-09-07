// ==UserScript==
// @name         Suno Workspace Duration Sum
// @namespace    https://hwiiza.example
// @version      2.1
// @description  Workspace の各曲に再生時間を表示し、Open in Studio 済みの曲を背景色で識別・解除。全曲の合計時間もスクロールで集計（List/Waveform/Grid 全表示モード対応）。
// @match        https://suno.com/*
// @match        https://www.suno.com/*
// @run-at       document-end
// @grant        none
// @updateURL    https://github.com/hwiiza/hwiiza.github.io/raw/refs/heads/main/SunoWorkspaceDurationSum.user.js
// @downloadURL  https://github.com/hwiiza/hwiiza.github.io/raw/refs/heads/main/SunoWorkspaceDurationSum.user.js
// ==/UserScript==

(function () {
  "use strict";

  console.log("[Suno ScrollSum] loaded (persistent badge)");

  const POS_KEY_BADGE = "suno_scrollsum_badge_pos_v1";
  const BADGE_ID = "suno-scrollsum-badge";
  const DURATION_LABEL_CLASS = "suno-scrollsum-duration";
  const DURATION_STYLE_ID = "suno-scrollsum-duration-style";
  const STUDIO_OPENED_IDS_KEY = "suno_scrollsum_studio_opened_ids_v1";
  const STUDIO_OPENED_CLASS = "suno-scrollsum-studio-opened";
  const STUDIO_FLAG_CLEAR_CLASS = "suno-scrollsum-studio-flag-clear";
  const CLIP_SELECTOR =
    'div[draggable="true"], [data-testid="clip-row"], a[href*="/song/"]';

  let observerStarted = false;
  let routeHooked = false;
  let studioOpenTrackingStarted = false;
  let durationScanScheduled = false;
  let activeContextClipId = null;

  /* ---------------------------
      Utility functions
  ----------------------------*/
  function parseDurationToSeconds(text) {
    const parts = text.trim().split(":").map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  function formatSeconds(totalSec) {
    totalSec = Math.round(totalSec);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  function loadStudioOpenedIds() {
    try {
      const value = JSON.parse(localStorage.getItem(STUDIO_OPENED_IDS_KEY) || "[]");
      if (!Array.isArray(value)) return new Set();
      return new Set(value.filter((id) => typeof id === "string" && id));
    } catch (error) {
      console.warn("[Suno ScrollSum] loadStudioOpenedIds error:", error);
      return new Set();
    }
  }

  function saveStudioOpenedId(clipId) {
    if (!clipId) return false;
    try {
      const ids = loadStudioOpenedIds();
      const before = ids.size;
      ids.add(String(clipId));
      if (ids.size !== before) {
        localStorage.setItem(STUDIO_OPENED_IDS_KEY, JSON.stringify([...ids]));
      }
      scheduleDurationLabels();
      return true;
    } catch (error) {
      console.warn("[Suno ScrollSum] saveStudioOpenedId error:", error);
      return false;
    }
  }

  function removeStudioOpenedId(clipId) {
    if (!clipId) return false;
    try {
      const ids = loadStudioOpenedIds();
      if (!ids.delete(String(clipId))) return false;
      localStorage.setItem(STUDIO_OPENED_IDS_KEY, JSON.stringify([...ids]));
      scheduleDurationLabels();
      return true;
    } catch (error) {
      console.warn("[Suno ScrollSum] removeStudioOpenedId error:", error);
      return false;
    }
  }

  /* ---------------------------
      position save / load
  ----------------------------*/
  function savePosition(key, el) {
    try {
      const rect = el.getBoundingClientRect();
      const pos = {
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
      };
      localStorage.setItem(key, JSON.stringify(pos));
    } catch (e) {
      console.warn("[Suno ScrollSum] savePosition error:", e);
    }
  }

  function loadPosition(key, el, fallbackTop, fallbackRight) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        el.style.top = fallbackTop;
        el.style.right = fallbackRight;
        el.style.left = "";
        return;
      }
      const pos = JSON.parse(raw);
      if (
        typeof pos.top === "number" &&
        typeof pos.left === "number" &&
        isFinite(pos.top) &&
        isFinite(pos.left)
      ) {
        el.style.top = pos.top + "px";
        el.style.left = pos.left + "px";
        el.style.right = "";
        return;
      }
    } catch (e) {
      console.warn("[Suno ScrollSum] loadPosition error:", e);
    }
    el.style.top = fallbackTop;
    el.style.right = fallbackRight;
    el.style.left = "";
  }

  /* ---------------------------
      Movable helper
  ----------------------------*/
  function makeMovable(el, storageKey) {
    let shiftX, shiftY;

    el._dragMoved = false;

    el.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;

      const rect = el.getBoundingClientRect();
      shiftX = event.clientX - rect.left;
      shiftY = event.clientY - rect.top;
      el._dragMoved = false;

      const prevBodyCursor = document.body ? document.body.style.cursor : "";
      if (document.body) document.body.style.cursor = "move";
      el.style.cursor = "move";

      function moveAt(e) {
        el.style.left = e.clientX - shiftX + "px";
        el.style.top = e.clientY - shiftY + "px";
        el.style.right = "";
        el._dragMoved = true;
      }

      function onMouseMove(e) {
        moveAt(e);
      }

      function onMouseUp() {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (document.body) document.body.style.cursor = prevBodyCursor || "";
        el.style.cursor = "pointer";

        if (el._dragMoved && storageKey) {
          savePosition(storageKey, el);
        }
      }

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    el.ondragstart = () => false;
  }

  /* ---------------------------
      scroll target finder
  ----------------------------*/
  function findScrollableAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const style = getComputedStyle(cur);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        cur.scrollHeight > cur.clientHeight + 20
      ) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  /* ---------------------------
      Inline data extraction (React fiber based — works in List/Waveform/Grid)
  ----------------------------*/
  function isDurationClip(value) {
    return (
      value &&
      typeof value === "object" &&
      value.id &&
      value.metadata &&
      typeof value.metadata.duration === "number" &&
      value.metadata.duration > 0
    );
  }

  function getClipFromProps(props) {
    if (!props || typeof props !== "object") return null;

    // Suno の表示モードやコンポーネント更新による props の包み方の差を吸収する。
    const directCandidates = [
      props.clip,
      props.item,
      props.song,
      props.data,
      props.item && props.item.clip,
      props.song && props.song.clip,
      props.data && props.data.clip,
    ];
    const directClip = directCandidates.find(isDurationClip);
    if (directClip) return directClip;

    // 名前が変わったラッパーにも対応するため、props の内側だけを浅く・上限付きで探す。
    // React fiber 本体や巨大な clip オブジェクト全体を再帰走査しない。
    const queue = [{ value: props, depth: 0 }];
    const visited = new WeakSet();
    let checked = 0;
    while (queue.length && checked < 60) {
      const current = queue.shift();
      const value = current.value;
      if (!value || typeof value !== "object" || visited.has(value)) continue;
      visited.add(value);
      checked++;

      if (isDurationClip(value)) return value;
      if (current.depth >= 2) continue;

      for (const key of Object.keys(value)) {
        if (key === "children" || key === "ref" || key === "_owner") continue;
        let child;
        try {
          child = value[key];
        } catch (_error) {
          continue;
        }
        if (isDurationClip(child)) return child;
        if (child && typeof child === "object") {
          queue.push({ value: child, depth: current.depth + 1 });
        }
      }
    }
    return null;
  }

  function getClipFromReactNode(node) {
    let depth = 0;
    while (node && depth < 80) {
      const clip =
        getClipFromProps(node.memoizedProps) || getClipFromProps(node.pendingProps);
      if (clip) return clip;
      node = node.return;
      depth++;
    }
    return null;
  }

  function getClipFromElement(el) {
    if (!el || typeof el !== "object") return null;

    // React の内部キーはビルドごとに末尾が変わる。カード本体にない場合は
    // 子要素の fiber/props も調べ、そこから親コンポーネントをたどる。
    const elements = [el, ...el.querySelectorAll("*")];
    for (const current of elements) {
      const keys = Object.keys(current);

      const propsKey = keys.find((key) => key.startsWith("__reactProps"));
      if (propsKey) {
        const clip = getClipFromProps(current[propsKey]);
        if (clip) return clip;
      }

      const fiberKey = keys.find((key) => key.startsWith("__reactFiber"));
      if (fiberKey) {
        const clip = getClipFromReactNode(current[fiberKey]);
        if (clip) return clip;
      }
    }
    return null;
  }

  function findClipScope() {
    // Workspace のソング一覧パネル(右側)を絞り込めるとスキャンが軽くなる。
    // 一旦 1 件でも clip を持つ要素を見つけて、そのスクロール祖先をスコープとして返す。
    const candidates = document.querySelectorAll(CLIP_SELECTOR);
    for (const el of candidates) {
      if (getClipFromElement(el)) return el;
    }
    return null;
  }

  function scanVisibleClips(root, seenIds, totals) {
    // root 配下のあらゆる要素を見て、React fiber に clip があるものを拾う。
    // 同じ clip が複数の DOM ノードに付いていても id 重複排除で 1 回しか加算しない。
    const scope = root && root.querySelectorAll ? root : document;
    const candidates = scope.querySelectorAll(CLIP_SELECTOR);
    for (const el of candidates) {
      const clip = getClipFromElement(el);
      if (!clip) continue;
      if (seenIds.has(clip.id)) continue;
      seenIds.add(clip.id);
      totals.totalSec += clip.metadata.duration;
      totals.count++;
    }
  }

  /* ---------------------------
      Badge create / ensure
  ----------------------------*/
  function getMountRoot() {
    return document.body || document.documentElement;
  }

  function createBadge() {
    const box = document.createElement("div");
    box.id = BADGE_ID;

    Object.assign(box.style, {
      position: "fixed",
      zIndex: "2147483647",
      padding: "6px 12px",
      borderRadius: "999px",
      fontSize: "12px",
      background: "rgba(246,130,32,0.82)",
      color: "white",
      whiteSpace: "nowrap",
      pointerEvents: "auto",
      fontFamily: "system-ui, sans-serif",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
      userSelect: "none",
    });

    loadPosition(POS_KEY_BADGE, box, "70px", "16px");

    box.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (box._dragMoved) {
        box._dragMoved = false;
        return;
      }
      sumAllWithScroll();
    });

    makeMovable(box, POS_KEY_BADGE);
    return box;
  }

  function ensureBadge(text = null) {
    const mountRoot = getMountRoot();
    if (!mountRoot) return null;

    let box = document.getElementById(BADGE_ID);

    if (!box) {
      box = createBadge();
      mountRoot.appendChild(box);
    } else if (!box.isConnected) {
      mountRoot.appendChild(box);
    }

    if (text !== null) {
      box.textContent = text;
    } else if (!box.textContent) {
      box.textContent = "再生時間を集計";
    }

    return box;
  }

  function showBadge(text) {
    ensureBadge(text);
  }

  /* ---------------------------
      Per-clip duration labels
  ----------------------------*/
  function ensureDurationStyle() {
    let style = document.getElementById(DURATION_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = DURATION_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }

    const styleText = `
      .${DURATION_LABEL_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        min-height: 16px;
        padding: 0 4px;
        border: 1px solid rgba(246, 130, 32, 0.7);
        border-radius: 3px;
        color: rgb(255, 176, 92);
        font: 600 11px/14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: nowrap;
        pointer-events: none;
      }

      .${STUDIO_OPENED_CLASS} {
        background-color: rgba(246, 130, 32, 0.16) !important;
        box-shadow: none !important;
        transition: background-color 120ms ease;
      }

      .${STUDIO_OPENED_CLASS}:hover {
        background-color: rgba(246, 130, 32, 0.24) !important;
      }

      .${STUDIO_FLAG_CLEAR_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        width: 16px;
        height: 16px;
        padding: 0;
        border: 1px solid rgba(246, 130, 32, 0.65);
        border-radius: 50%;
        background: transparent;
        color: rgb(255, 176, 92);
        font: 700 12px/1 system-ui, sans-serif;
        cursor: pointer;
      }

      .${STUDIO_FLAG_CLEAR_CLASS}:hover {
        background: rgba(246, 130, 32, 0.28);
        color: white;
      }
    `;
    if (style.textContent !== styleText) style.textContent = styleText;
  }

  function findDurationMount(row) {
    const spans = row.querySelectorAll("span");
    for (const span of spans) {
      if (/^\s*\d+\s*BPM\s*$/i.test(span.textContent || "")) {
        return span.parentElement;
      }
    }
    return null;
  }

  function updateVisibleDurationLabels() {
    ensureDurationStyle();

    const rows = document.querySelectorAll(CLIP_SELECTOR);
    const studioOpenedIds = loadStudioOpenedIds();
    for (const row of rows) {
      let label = row.querySelector(`.${DURATION_LABEL_CLASS}`);
      let clearButton = row.querySelector(`.${STUDIO_FLAG_CLEAR_CLASS}`);
      const clip = getClipFromElement(row);

      if (!clip) {
        if (label) label.remove();
        if (clearButton) clearButton.remove();
        row.classList.remove(STUDIO_OPENED_CLASS);
        delete row.dataset.sunoStudioOpened;
        continue;
      }

      const studioOpened = studioOpenedIds.has(String(clip.id));
      row.classList.toggle(STUDIO_OPENED_CLASS, studioOpened);
      if (studioOpened) {
        row.dataset.sunoStudioOpened = "true";
      } else {
        delete row.dataset.sunoStudioOpened;
      }

      const mount = findDurationMount(row);
      if (!mount) {
        if (!studioOpened && clearButton) clearButton.remove();
        continue;
      }

      if (!label) {
        label = document.createElement("span");
        label.className = DURATION_LABEL_CLASS;
        label.title = "再生時間";
        label.setAttribute("aria-label", "再生時間");
        mount.appendChild(label);
      } else if (label.parentElement !== mount) {
        mount.appendChild(label);
      }

      const durationText = formatSeconds(clip.metadata.duration);
      if (label.textContent !== durationText) label.textContent = durationText;
      if (label.dataset.clipId !== String(clip.id)) {
        label.dataset.clipId = String(clip.id);
      }

      if (studioOpened) {
        if (!clearButton) {
          clearButton = document.createElement("button");
          clearButton.type = "button";
          clearButton.className = STUDIO_FLAG_CLEAR_CLASS;
          clearButton.textContent = "×";
          clearButton.title = "Open in Studio フラグを解除";
          clearButton.setAttribute("aria-label", "Open in Studio フラグを解除");
          clearButton.addEventListener("pointerdown", (event) => {
            event.stopPropagation();
          });
          clearButton.addEventListener("mousedown", (event) => {
            event.stopPropagation();
          });
          clearButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            removeStudioOpenedId(clearButton.dataset.clipId);
          });
        }
        clearButton.dataset.clipId = String(clip.id);
        if (clearButton.parentElement !== mount) mount.appendChild(clearButton);
      } else if (clearButton) {
        clearButton.remove();
      }
    }
  }

  function scheduleDurationLabels() {
    if (durationScanScheduled) return;
    durationScanScheduled = true;
    requestAnimationFrame(() => {
      durationScanScheduled = false;
      updateVisibleDurationLabels();
    });
  }

  function mutationAffectsClipRows(mutation) {
    const target = mutation.target;
    if (
      target &&
      target.nodeType === Node.ELEMENT_NODE &&
      target.closest(CLIP_SELECTOR) &&
      !target.closest(`.${DURATION_LABEL_CLASS}`)
    ) {
      return true;
    }

    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches(CLIP_SELECTOR) || node.querySelector(CLIP_SELECTOR)) return true;
    }
    return false;
  }

  /* ---------------------------
      Open in Studio tracking
  ----------------------------*/
  function startOpenInStudioTracking() {
    if (studioOpenTrackingStarted) return;
    studioOpenTrackingStarted = true;

    // メニューは body 直下の portal に出るため、More を押した時点で元カードを保持する。
    document.addEventListener(
      "click",
      (event) => {
        const target =
          event.target && event.target.nodeType === Node.ELEMENT_NODE
            ? event.target
            : event.target && event.target.parentElement;
        if (!target) return;

        const moreButton = target.closest('button[aria-label="More"]');
        if (moreButton) {
          const row = moreButton.closest(CLIP_SELECTOR);
          const clip = row ? getClipFromElement(row) : null;
          activeContextClipId = clip ? String(clip.id) : null;
          return;
        }

        const openInStudioButton = target.closest(
          'button[aria-label="Open in Studio"]'
        );
        if (openInStudioButton && activeContextClipId) {
          saveStudioOpenedId(activeContextClipId);
        }
      },
      true
    );
  }

  /* ---------------------------
      Full scroll → sum all data
  ----------------------------*/
  async function sumAllWithScroll() {
    ensureBadge("集計中...");

    const anchor = findClipScope();
    if (!anchor) {
      showBadge("曲情報なし");
      return;
    }

    const scrollEl = findScrollableAncestor(anchor);
    const startTop = scrollEl.scrollTop;
    const seenIds = new Set();
    const totals = { totalSec: 0, count: 0 };

    let loops = 0;
    const maxLoops = 500;
    const step = Math.max(60, Math.floor(scrollEl.clientHeight * 0.85));

    scanVisibleClips(scrollEl, seenIds, totals);

    while (
      scrollEl.scrollTop + scrollEl.clientHeight < scrollEl.scrollHeight - 5 &&
      loops < maxLoops
    ) {
      loops++;
      const before = totals.count;
      scrollEl.scrollTop += step;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      scanVisibleClips(scrollEl, seenIds, totals);
      ensureBadge(`集計中... ${totals.count}曲`);
      // 進捗が止まったらもう一度だけ待ってからbreak（virtualizedの遅延ロード対策）
      if (totals.count === before && loops > 3) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        scanVisibleClips(scrollEl, seenIds, totals);
      }
    }

    scrollEl.scrollTop = startTop;

    if (totals.count === 0) {
      showBadge("曲情報なし");
      return;
    }

    showBadge(`${totals.count}曲・${formatSeconds(totals.totalSec)}`);
  }

  /* ---------------------------
      Persistent mount
  ----------------------------*/
  function startBadgeObserver() {
    if (observerStarted) return;
    observerStarted = true;

    const observer = new MutationObserver((mutations) => {
      ensureBadge();
      if (mutations.some(mutationAffectsClipRows)) scheduleDurationLabels();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // 念のための保険
    setInterval(() => {
      ensureBadge();
      scheduleDurationLabels();
    }, 1500);
  }

  function hookHistoryEvents() {
    if (routeHooked) return;
    routeHooked = true;

    const wrap = (fnName) => {
      const orig = history[fnName];
      if (typeof orig !== "function") return;
      history[fnName] = function (...args) {
        const ret = orig.apply(this, args);
        activeContextClipId = null;
        setTimeout(() => ensureBadge(), 0);
        setTimeout(() => ensureBadge(), 300);
        setTimeout(() => ensureBadge(), 1000);
        setTimeout(() => scheduleDurationLabels(), 0);
        setTimeout(() => scheduleDurationLabels(), 300);
        setTimeout(() => scheduleDurationLabels(), 1000);
        return ret;
      };
    };

    wrap("pushState");
    wrap("replaceState");

    window.addEventListener("popstate", () => {
      activeContextClipId = null;
      setTimeout(() => ensureBadge(), 0);
      setTimeout(() => ensureBadge(), 300);
      setTimeout(() => ensureBadge(), 1000);
      setTimeout(() => scheduleDurationLabels(), 0);
      setTimeout(() => scheduleDurationLabels(), 300);
      setTimeout(() => scheduleDurationLabels(), 1000);
    });
  }

  /* ---------------------------
      Init
  ----------------------------*/
  function init() {
    if (!/suno\.com$/.test(location.hostname)) return;
    ensureBadge("再生時間を集計");
    scheduleDurationLabels();
    startBadgeObserver();
    startOpenInStudioTracking();
    hookHistoryEvents();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init, { once: true });
  }

  // 追加の保険
  window.addEventListener("load", init, { once: true });
})();
