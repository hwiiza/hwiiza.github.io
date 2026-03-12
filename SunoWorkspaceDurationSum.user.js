// ==UserScript==
// @name         Suno Workspace Duration Sum
// @namespace    https://hwiiza.example
// @version      1.8
// @description  Workspace 全曲の再生時間をスクロールで集計。右上のバッジを常時表示＆ドラッグ移動＆位置記憶。シングルクリックで集計実行。
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

  let observerStarted = false;
  let routeHooked = false;

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

  function findRowGroup() {
    const groups = Array.from(document.querySelectorAll('div[role="rowgroup"]'));
    if (!groups.length) return null;
    return groups.find((g) => g.querySelector('[data-testid="clip-row"]')) || groups[0];
  }

  /* ---------------------------
      Inline data extraction
  ----------------------------*/
  function getSongIdFromRow(row) {
    const link = row.querySelector('a[href*="/song/"]');
    if (!link) return null;
    const href = link.getAttribute("href") || "";
    const m = href.match(/\/song\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function getDurationFromRow(row) {
    const nodes = row.querySelectorAll("div, span");
    const re = /^\s*\d+:\d{2}\s*$/;
    for (const el of nodes) {
      const t = (el.textContent || "").trim();
      if (!re.test(t)) continue;
      const sec = parseDurationToSeconds(t);
      if (sec > 0) return sec;
    }
    return 0;
  }

  function scanVisibleRows(rowgroup, seenIds, totals) {
    const rows = rowgroup.querySelectorAll('[data-testid="clip-row"]');
    rows.forEach((row) => {
      const id = getSongIdFromRow(row);
      if (!id || seenIds.has(id)) return;

      const sec = getDurationFromRow(row);
      if (sec <= 0) return;

      seenIds.add(id);
      totals.totalSec += sec;
      totals.count++;
    });
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
      Full scroll → sum all data
  ----------------------------*/
  async function sumAllWithScroll() {
    const badge = ensureBadge("集計中...");
    const rowgroup = findRowGroup();

    if (!rowgroup) {
      showBadge("曲情報なし");
      return;
    }

    const scrollEl = findScrollableAncestor(rowgroup);
    const startTop = scrollEl.scrollTop;
    const seenIds = new Set();
    const totals = { totalSec: 0, count: 0 };

    let loops = 0;
    const maxLoops = 500;
    const step = Math.max(60, Math.floor(scrollEl.clientHeight * 0.85));

    scanVisibleRows(rowgroup, seenIds, totals);

    while (
      scrollEl.scrollTop + scrollEl.clientHeight < scrollEl.scrollHeight - 5 &&
      loops < maxLoops
    ) {
      loops++;
      scrollEl.scrollTop += step;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      scanVisibleRows(rowgroup, seenIds, totals);
      ensureBadge(badge ? badge.textContent : "集計中...");
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

    const observer = new MutationObserver(() => {
      ensureBadge();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // 念のための保険
    setInterval(() => {
      ensureBadge();
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
        setTimeout(() => ensureBadge(), 0);
        setTimeout(() => ensureBadge(), 300);
        setTimeout(() => ensureBadge(), 1000);
        return ret;
      };
    };

    wrap("pushState");
    wrap("replaceState");

    window.addEventListener("popstate", () => {
      setTimeout(() => ensureBadge(), 0);
      setTimeout(() => ensureBadge(), 300);
      setTimeout(() => ensureBadge(), 1000);
    });
  }

  /* ---------------------------
      Init
  ----------------------------*/
  function init() {
    if (!/suno\.com$/.test(location.hostname)) return;
    ensureBadge("再生時間を集計");
    startBadgeObserver();
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
