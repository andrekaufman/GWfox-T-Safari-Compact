// ==UserScript==
// @name           Safari Compact for GWfox-T
// @description    Safari-style active-tab address field for GWfox-T
// @include        main
// ==/UserScript==

(() => {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;
  if (window.__safariCompactCleanup) window.__safariCompactCleanup();

  const tabs = gBrowser.tabContainer;
  const urlbar = document.querySelector("#urlbar");
  const input = urlbar?.querySelector(".urlbar-input");
  const toolbar = document.querySelector("#TabsToolbar");

  if (!tabs || !urlbar || !input || !toolbar) return;

  const closeButton = document.createElement("button");
  closeButton.id = "safari-v8-exact-close";
  closeButton.type = "button";
  closeButton.tabIndex = -1;
  closeButton.title = "Stäng flik";
  closeButton.setAttribute("aria-label", "Stäng flik");
  document.documentElement.appendChild(closeButton);

  let visible = false;
  let closeHover = false;
  let frame = 0;
  let settleTimer = 0;
  let resizeObserver = null;
  const shifted = new Set();

  const preferredExpansion = 64;
  const safetyGap = 10;

  function selectedTab() {
    const tab = gBrowser.selectedTab;
    return tab && !tab.hidden && !tab.closing ? tab : null;
  }

  function clearAddressState() {
    tabs.querySelectorAll(".safari-v8-address").forEach(tab => {
      tab.classList.remove("safari-v8-address");
    });
  }

  function clearPush() {
    for (const element of shifted) {
      element.classList.remove("safari-v8-pushed");
      element.style.removeProperty("--safari-v8-push");
    }
    shifted.clear();
    urlbar.style.removeProperty("--safari-v8-expand");
  }

  function hideClose() {
    closeHover = false;
    closeButton.classList.remove("visible");
    urlbar.classList.remove("safari-v8-exact-close-hover");
  }

  function setVisible(state) {
    visible = state;
    urlbar.classList.toggle("safari-v8-visible", state);
    clearAddressState();
    const tab = selectedTab();
    if (state && tab) tab.classList.add("safari-v8-address");
    if (!state) hideClose();
  }

  function positionUrlbar() {
    const tab = selectedTab();
    if (!tab) return;

    const rect = tab.getBoundingClientRect();
    const xGap = 4;
    const yGap = 4;

    urlbar.style.setProperty("--safari-v8-left", `${rect.left + xGap}px`);
    urlbar.style.setProperty("--safari-v8-top", `${rect.top + yGap}px`);
    urlbar.style.setProperty("--safari-v8-width", `${Math.max(1, rect.width - xGap * 2)}px`);
    urlbar.style.setProperty("--safari-v8-height", `${Math.max(1, rect.height - yGap * 2)}px`);

    if (visible) {
      clearAddressState();
      tab.classList.add("safari-v8-address");
    }
  }

  function plusButton() {
    return document.querySelector("#tabs-newtab-button") ||
      document.querySelector("#new-tab-button");
  }

  function rightBoundary(plusRect) {
    const selectors = [
      "#nav-bar-overflow-button",
      "#unified-extensions-button",
      "#downloads-button",
      "#alltabs-button",
      "#PanelUI-menu-button"
    ];

    const positions = selectors
      .map(selector => document.querySelector(selector))
      .filter(element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.left > plusRect.left &&
          style.display !== "none" && style.visibility !== "hidden";
      })
      .map(element => element.getBoundingClientRect().left);

    return positions.length ? Math.min(...positions) : window.innerWidth - safetyGap;
  }

  function safeExpansion(plus) {
    if (!plus) return 0;
    const rect = plus.getBoundingClientRect();
    const style = getComputedStyle(plus);
    if (rect.width <= 0 || style.display === "none" || style.visibility === "hidden") return 0;
    const available = Math.floor(rightBoundary(rect) - rect.right - safetyGap);
    return available > 0 ? Math.min(preferredExpansion, available) : 0;
  }

  function applyPush() {
    clearPush();
    if (!visible) return;

    const active = selectedTab();
    const plus = plusButton();
    if (!active) return;

    const expansion = safeExpansion(plus);
    if (expansion < 8) return;

    urlbar.style.setProperty("--safari-v8-expand", `${expansion}px`);

    let afterActive = false;
    for (const tab of gBrowser.tabs) {
      if (tab === active) {
        afterActive = true;
        continue;
      }
      if (afterActive && !tab.hidden && !tab.closing) {
        tab.classList.add("safari-v8-pushed");
        tab.style.setProperty("--safari-v8-push", `${expansion}px`);
        shifted.add(tab);
      }
    }

    if (plus) {
      plus.classList.add("safari-v8-pushed");
      plus.style.setProperty("--safari-v8-push", `${expansion}px`);
      shifted.add(plus);
    }
  }

  function render() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      positionUrlbar();
      applyPush();
      if (closeHover) positionCloseButton();
    });
  }

  function settle() {
    clearTimeout(settleTimer);
    render();
    settleTimer = setTimeout(render, 120);
  }

  function openUrlbar() {
    const tab = selectedTab();
    if (!tab) return;

    // Prepare every visual state before focus can trigger Firefox painting.
    tab.classList.add("safari-v8-address");
    positionUrlbar();
    setVisible(true);
    applyPush();

    requestAnimationFrame(() => {
      gURLBar.focus();
      gURLBar.select();
      positionUrlbar();
      applyPush();
    });
  }

  function closeUrlbar() {
    setVisible(false);
    clearPush();
  }

  function positionCloseButton() {
    const rect = urlbar.getBoundingClientRect();
    const size = 18;
    const centerX = rect.left + 20;
    const centerY = rect.top + rect.height / 2;
    closeButton.style.setProperty("--close-left", `${centerX - size / 2}px`);
    closeButton.style.setProperty("--close-top", `${centerY - size / 2}px`);
  }

  function showClose() {
    closeHover = true;
    positionCloseButton();
    urlbar.classList.add("safari-v8-exact-close-hover");
    closeButton.classList.add("visible");
  }

  function onPointerMove(event) {
    if (!visible) {
      hideClose();
      return;
    }

    const rect = urlbar.getBoundingClientRect();
    const inLeadingZone = event.clientX >= rect.left &&
      event.clientX <= rect.left + 40 &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
    const onButton = event.target === closeButton || closeButton.contains(event.target);

    if (inLeadingZone || onButton) showClose();
    else hideClose();
  }

  function blockClosePress(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function closeSelectedTab(event) {
    blockClosePress(event);
    const tab = selectedTab();
    if (!tab) return;
    hideClose();
    gBrowser.removeTab(tab, { animate: true, byMouse: true });
  }

  function onTabPointerDown(event) {
    if (event.button !== 0 || event.target.closest?.(".tab-close-button")) return;
    const tab = event.target.closest?.(".tabbrowser-tab");
    if (tab && tab === gBrowser.selectedTab) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openUrlbar();
    }
  }

  function onTabSelect() {
    closeUrlbar();
    settle();
  }

  function onFocusIn(event) {
    if (event.target === input || urlbar.contains(event.target)) {
      setVisible(true);
      render();
    }
  }

  function onFocusOut() {
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused !== input && !urlbar.contains(focused)) closeUrlbar();
    });
  }

  function onKeyDown(event) {
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      event.stopImmediatePropagation();
      openUrlbar();
    }
  }

  const layoutEvents = ["TabOpen", "TabClose", "TabMove", "TabPinned", "TabUnpinned"];

  urlbar.classList.add("safari-v8-moving");
  tabs.addEventListener("pointerdown", onTabPointerDown, true);
  tabs.addEventListener("TabSelect", onTabSelect);
  layoutEvents.forEach(name => tabs.addEventListener(name, settle));
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", settle);
  closeButton.addEventListener("pointerdown", blockClosePress, true);
  closeButton.addEventListener("mousedown", blockClosePress, true);
  closeButton.addEventListener("click", closeSelectedTab, true);

  resizeObserver = new ResizeObserver(render);
  resizeObserver.observe(toolbar);

  window.__safariCompactCleanup = () => {
    cancelAnimationFrame(frame);
    clearTimeout(settleTimer);
    resizeObserver?.disconnect();
    tabs.removeEventListener("pointerdown", onTabPointerDown, true);
    tabs.removeEventListener("TabSelect", onTabSelect);
    layoutEvents.forEach(name => tabs.removeEventListener(name, settle));
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", settle);
    closeButton.removeEventListener("pointerdown", blockClosePress, true);
    closeButton.removeEventListener("mousedown", blockClosePress, true);
    closeButton.removeEventListener("click", closeSelectedTab, true);
    closeUrlbar();
    clearAddressState();
    urlbar.classList.remove("safari-v8-moving", "safari-v8-visible", "safari-v8-exact-close-hover");
    ["--safari-v8-left", "--safari-v8-top", "--safari-v8-width", "--safari-v8-height", "--safari-v8-expand"]
      .forEach(property => urlbar.style.removeProperty(property));
    closeButton.remove();
    delete window.__safariCompactCleanup;
  };

  settle();
})();
