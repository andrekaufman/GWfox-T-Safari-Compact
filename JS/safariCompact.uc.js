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

  const shelfPaintHost = document.querySelector("#nav-bar");
  const inputContainer = urlbar.querySelector(".urlbar-input-container");
  const glyphSlot = document.querySelector("#trust-icon-container");
  const glyph = document.querySelector("#trust-icon");

  /*
   * Validate every native prerequisite before taking ownership of DOM.
   * A partial initialization therefore leaves no nodes or cleanup handle.
   */
  if (!shelfPaintHost || !inputContainer || !glyphSlot || !glyph) return;

  const lifecycle = {
    disposed: false,
    generation: 0,
    disposers: []
  };

  function own(disposer) {
    lifecycle.disposers.push(disposer);
    return disposer;
  }

  function ownEvent(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    own(() => target.removeEventListener(type, listener, options));
  }

  function ownObserver(observer) {
    own(() => observer.disconnect());
    return observer;
  }

  function ownNode(node) {
    own(() => node.remove());
    return node;
  }

  function patchMethod(owner, name, replacement) {
    const original = owner?.[name];
    if (typeof original !== "function") return original;

    owner[name] = replacement;
    own(() => {
      if (owner[name] === replacement) owner[name] = original;
    });
    return original;
  }

  const scheduler = (() => {
    const frames = new Map();
    const timers = new Map();
    const oneShotTimers = new Set();

    function cancelFrame(name) {
      const handle = frames.get(name);
      if (handle == null) return;
      cancelAnimationFrame(handle);
      frames.delete(name);
    }

    function scheduleFrame(name, callback) {
      cancelFrame(name);
      const generation = lifecycle.generation;
      const handle = requestAnimationFrame(timestamp => {
        if (frames.get(name) === handle) frames.delete(name);
        if (!lifecycle.disposed && generation === lifecycle.generation) {
          callback(timestamp);
        }
      });
      frames.set(name, handle);
      return handle;
    }

    function cancelTimer(name) {
      const handle = timers.get(name);
      if (handle == null) return;
      clearTimeout(handle);
      timers.delete(name);
    }

    function scheduleTimer(name, callback, delay) {
      cancelTimer(name);
      const generation = lifecycle.generation;
      const handle = setTimeout(() => {
        if (timers.get(name) === handle) timers.delete(name);
        if (!lifecycle.disposed && generation === lifecycle.generation) {
          callback();
        }
      }, delay);
      timers.set(name, handle);
      return handle;
    }

    function scheduleOneShotTimer(callback, delay) {
      const generation = lifecycle.generation;
      const handle = setTimeout(() => {
        oneShotTimers.delete(handle);
        if (!lifecycle.disposed && generation === lifecycle.generation) {
          callback();
        }
      }, delay);
      oneShotTimers.add(handle);
      return handle;
    }

    function scheduleMicrotask(callback) {
      const generation = lifecycle.generation;
      queueMicrotask(() => {
        if (!lifecycle.disposed && generation === lifecycle.generation) {
          callback();
        }
      });
    }

    function invalidate() {
      lifecycle.generation += 1;
      for (const handle of frames.values()) cancelAnimationFrame(handle);
      for (const handle of timers.values()) clearTimeout(handle);
      for (const handle of oneShotTimers) clearTimeout(handle);
      frames.clear();
      timers.clear();
      oneShotTimers.clear();
    }

    return {
      cancelFrame,
      scheduleFrame,
      cancelTimer,
      scheduleTimer,
      scheduleOneShotTimer,
      scheduleMicrotask,
      invalidate
    };
  })();

  const closeButton = ownNode(document.createElement("button"));
  closeButton.id = "safari-v8-exact-close";
  closeButton.type = "button";
  closeButton.tabIndex = -1;
  closeButton.title = "Stäng flik";
  closeButton.setAttribute("aria-label", "Stäng flik");

  const reloadButton = ownNode(document.createElement("button"));
  reloadButton.id = "safari-v8-tab-reload";
  reloadButton.type = "button";
  reloadButton.tabIndex = -1;
  reloadButton.title = "Ladda om sida";
  reloadButton.setAttribute("aria-label", "Ladda om sida");

  const shelfProbe = ownNode(document.createElement("div"));
  shelfProbe.id = "safari-v8-shelf-geometry-probe";
  shelfProbe.setAttribute("aria-hidden", "true");

  document.documentElement.appendChild(closeButton);
  document.documentElement.appendChild(reloadButton);
  /*
   * Keep the shelf below both address and native tab surfaces.
   * TabsToolbar paints above nav-bar; placing the shelf inside TabsToolbar
   * also tinted the address field underneath that toolbar.
   * Fixed positioning retains the existing viewport geometry.
   */
  shelfPaintHost.prepend(shelfProbe);

  let visible = false;
  let closeHover = false;
  let reloadHover = false;
  let newTabOpening = false;
  let restoreTabCommandPending = false;
  let newTabGeometryToken = 0;
  let sharedOpeningGeometry = null;
  let addressOwner = null;
  let shelfProbeAnimationToken = 0;
  const safetyGap = 10;

  function selectedTab() {
    const tab = gBrowser.selectedTab;
    return tab && !tab.hidden && !tab.closing ? tab : null;
  }

  function safariDisplayLabel(tab) {
    if (!tab) return "";

    const spec = tab.linkedBrowser?.currentURI?.spec || "";
    if (spec === "about:newtab" || spec === "about:home" || spec === "about:blank") {
      return tab.label || "Ny flik";
    }

    try {
      const uri = Services.io.newURI(spec);
      if (uri.host) return uri.host.replace(/^www\./i, "");
    } catch {}

    return tab.label || "";
  }

  function compactSafariDisplayLabel(tab, fullLabel) {
    tab.classList.remove("safari-v8-compact-tab");
    return fullLabel;
  }

  function updateSafariDisplayLabel(tab) {
    if (!tab || tab.hidden || tab.closing) return;
    const label = tab.querySelector(".tab-label");
    if (!label) return;

    const displayLabel = compactSafariDisplayLabel(
      tab,
      safariDisplayLabel(tab)
    );

    if (
      label.getAttribute("data-safari-display-label") !== displayLabel
    ) {
      label.setAttribute("data-safari-display-label", displayLabel);
    }
  }

  function updateAllSafariDisplayLabels() {
    for (const tab of gBrowser.tabs) updateSafariDisplayLabel(tab);
  }

  function onSafariTabAttrModified(event) {
    if (lifecycle.disposed) return;
    updateSafariDisplayLabel(event.target);
  }

  function clearAddressState() {
    tabs.querySelectorAll(".safari-v8-address").forEach(tab => {
      tab.classList.remove("safari-v8-address");
    });
  }

  let tabCloseTarget = null;
  let selectedTabClickCandidate = null;

  /*
   * Firefox shifts the complete tab strip by about 52 px when the selected
   * tab changes between having and not having navigation history.
   * Capture the pre-change geometry and visually bridge that reflow.
   */

  function hideClose() {
    closeHover = false;
    closeButton.classList.remove("visible");
    urlbar.classList.remove("safari-v8-exact-close-hover");
    glyphSlot.classList.remove("safari-v8-close-mask");
    tabCloseTarget?.classList.remove("safari-v8-close-over-icon");

    /*
     * The clean glyph is a separate root-level copy. Restore it only after
     * the close-hover state and its mask have been removed.
     */
    if (visible) {
      scheduler.scheduleMicrotask(updateGlyph);
    }
  }

  function hideReload() {
    reloadHover = false;
    reloadButton.classList.remove("visible");
  }

  function setVisible(state) {
    if (lifecycle.disposed) return;
    visible = state;
    document.documentElement.classList.toggle("safari-v8-address-active", state);
    urlbar.classList.toggle("safari-v8-visible", state);
    clearAddressState();
    const tab = selectedTab();

    if (state && tab) {
      addressOwner = tab;
      tab.classList.add("safari-v8-address");
    } else if (!state) {
      urlbar.classList.remove("safari-v8-newtab-enter");
      addressOwner = null;
          hideClose();
    }
    if (noScrollLayoutEnabled()) updateNoScrollLayout();
  }

  let contentHandoffAnimations = [];

  function cancelContentHandoff() {
    for (const animation of contentHandoffAnimations) animation.cancel();
    contentHandoffAnimations = [];
  }

  function animateContentHandoff(element, deltaX, timing = {
    duration: 125, easing: "cubic-bezier(.2, .8, .2, 1)"
  }) {
    if (!element || !Number.isFinite(deltaX) ||
        Math.abs(deltaX) < 0.5 ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const animation = element.animate(
      [
        { translate: `${deltaX}px 0px` },
        { translate: "0px 0px" }
      ],
      timing
    );
    contentHandoffAnimations.push(animation);
    animation.finished.catch(() => null).then(() => {
      if (lifecycle.disposed) return;
      contentHandoffAnimations =
        contentHandoffAnimations.filter(item => item !== animation);
    });
  }

  function noScrollLayoutEnabled() {
    return document.documentElement.classList.contains(
      "safari-v8-no-scroll"
    );
  }

  function pixels(value) {
    return Number.parseFloat(value) || 0;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function setStyleProperty(element, name, value, priority = "") {
    if (!element) return;
    if (element.style.getPropertyValue(name) === value &&
        element.style.getPropertyPriority(name) === priority) return;
    element.style.setProperty(name, value, priority);
  }

  function setPixelProperty(element, name, value, priority = "") {
    setStyleProperty(element, name, `${value.toFixed(3)}px`, priority);
  }

  function setClassState(element, name, enabled) {
    if (!element || element.classList.contains(name) === enabled) return;
    element.classList.toggle(name, enabled);
  }

  function tabPaintRect(tab) {
    return tab?.querySelector(".tab-background")?.getBoundingClientRect() ||
      tab?.getBoundingClientRect() || null;
  }

  function eligibleTabs() {
    return [...gBrowser.tabs].filter(
      tab => !tab.hidden && !tab.closing && !tab.pinned
    );
  }

  /*
   * Shared shelf capture authority. Every field below is a browser-state or
   * DOM read. Callers derive presentation from this immutable transaction
   * snapshot rather than independently measuring the same shelf.
   */
  function captureShelfMetrics({includeTabs = false} = {}) {
    const ordinaryTabs = eligibleTabs();
    const active = selectedTab();
    const containerRect = tabs.getBoundingClientRect();
    const containerStyle = getComputedStyle(tabs);
    const paddingLeft = pixels(containerStyle.paddingLeft);
    const paddingRight = pixels(containerStyle.paddingRight);
    const pinnedRect = document.querySelector("#pinned-tabs-container")
      ?.getBoundingClientRect() || null;
    const arrow = document.querySelector("#tabbrowser-arrowscrollbox");
    const arrowRect = arrow?.getBoundingClientRect() || null;
    const opening = sharedOpeningGeometry;
    const presentationOpening = newTabOpening && opening;
    const closing = !newTabOpening && [...gBrowser.tabs].some(tab =>
      tab.closing || tab.classList.contains("safari-v8-retiring")
    );
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const tabMetrics = includeTabs
      ? ordinaryTabs.map(tab => {
          const rect = tab.getBoundingClientRect();
          const content = tab.querySelector(".tab-content");
          const icon = tab.querySelector(".tab-icon-stack");
          const label = tab.querySelector(".tab-label");
          const labelContainer = tab.querySelector(".tab-label-container");
          const contentRect = content?.getBoundingClientRect() || null;
          const iconRect = icon?.getBoundingClientRect() || null;
          const contentStyle = content ? getComputedStyle(content) : null;
          const fontStyle = label ? getComputedStyle(label, "::after") : null;
          return {
            tab,
            rect,
            content,
            icon,
            labelContainer,
            contentRect,
            iconRect,
            contentStyle,
            fontSize: pixels(fontStyle?.fontSize),
            currentIconOnly:
              tab.classList.contains("safari-v8-icon-only")
          };
        })
      : [];

    return {
      ordinaryTabs,
      active,
      activeIncluded: ordinaryTabs.includes(active),
      containerRect,
      paddingLeft,
      paddingRight,
      pinnedWidth: pinnedRect?.width || 0,
      arrow,
      arrowRect,
      opening,
      presentationOpening,
      closing,
      reduceMotion,
      newTabOpening,
      draggedControlTab,
      viewportWidth: window.innerWidth,
      tabMetrics
    };
  }

  /*
   * Pure no-scroll derivation. It receives all browser and DOM measurements
   * through the capture snapshot and performs no reads or writes itself.
   */
  function deriveNoScrollGeometry(snapshot) {
    const count = snapshot.ordinaryTabs.length;
    const available = Math.max(
      0,
      snapshot.containerRect.width -
        snapshot.paddingLeft -
        snapshot.paddingRight -
        snapshot.pinnedWidth
    );
    if (!count || available <= 0) return null;

    const rowWidth = Math.min(
      available,
      snapshot.viewportWidth * count / 4
    );
    const allocation = noScrollTabAllocation(
      rowWidth,
      count,
      snapshot.activeIncluded
    );
    const start = snapshot.containerRect.left +
      snapshot.paddingLeft + snapshot.pinnedWidth;
    const targetOffset = clamp(
      (snapshot.viewportWidth - rowWidth) / 2 - start,
      0,
      available - rowWidth
    );
    const opening = snapshot.opening;
    const progress = opening?.progress ?? 1;
    const paintedRowWidth = opening && !opening.fullShelf
      ? opening.width + (rowWidth - opening.width) * progress
      : rowWidth;
    const rowOffset = opening && !opening.fullShelf
      ? opening.left - start +
        (targetOffset - (opening.left - start)) * progress
      : targetOffset;
    const stationaryRight = opening &&
      count > 4 &&
      snapshot.ordinaryTabs.at(-1) === opening.tab &&
      opening.fullShelf
      ? start + targetOffset + rowWidth
      : null;

    const tabGeometry = snapshot.tabMetrics.map((metric, index) => {
      const active = metric.tab === snapshot.active;
      const width = active ? allocation.selected : allocation.ordinary;
      let iconOnly = false;

      if (!active && metric.contentRect && metric.iconRect &&
          metric.contentStyle) {
        const style = metric.contentStyle;
        const gap = Math.max(5.5, pixels(style.columnGap));
        const textBudget = metric.contentRect.width -
          pixels(style.borderLeftWidth) -
          pixels(style.borderRightWidth) -
          Math.max(30, pixels(style.paddingLeft)) -
          Math.max(8, pixels(style.paddingRight)) -
          metric.iconRect.width - gap;
        const minimumTextBudget = 2.75 * (metric.fontSize || 13);
        const releasedWidth = snapshot.closing
          ? Math.max(0, width - metric.rect.width)
          : 0;
        const openingWidthDelta = snapshot.presentationOpening
          ? width - metric.rect.width
          : 0;
        iconOnly = textBudget + releasedWidth + openingWidthDelta <
          minimumTextBudget;
      }

      return {
        ...metric,
        active,
        width,
        grow: active ? allocation.selectedGrow : 1,
        startInset: index === 0 ? 2 : 0,
        endInset: index === count - 1 ? 3 : 0,
        iconOnly
      };
    });

    return {
      available,
      paintedRowWidth,
      editWidth: allocation.selected,
      rowOffset,
      stationaryRight,
      dense: count >= 9,
      tabGeometry
    };
  }

  // Mask text/icons behind the moving capsule without changing glass paint,
  // native tab allocation, or pointer targets.
  const openingContentMasks = new Set();

  // Content-only FLIP driven by the existing native opening clock.
  const openingContentSlides = new Map();

  function clearOpeningContentSlide() {
    for (const [element, state] of openingContentSlides) {
      if (state.value) {
        element.style.setProperty("translate", state.value, state.priority);
      } else {
        element.style.removeProperty("translate");
      }
    }
    openingContentSlides.clear();
  }

  function updateOpeningContentSlide() {
    const opening = sharedOpeningGeometry;
    if (!visible || opening?.tab !== selectedTab() ||
        opening.stationaryRight == null ||
        !opening.contentOrigins ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      clearOpeningContentSlide();
      return;
    }
    const progress = Math.max(0, Math.min(1, opening.progress));
    for (const origin of opening.contentOrigins) {
      const element = origin.element;
      let state = openingContentSlides.get(element);
      if (!state) {
        state = {
          value: element.style.getPropertyValue("translate"),
          priority: element.style.getPropertyPriority("translate"),
          offset: 0,
          delta: null
        };
        // Do not take ownership from an existing content transform.
        const translate = getComputedStyle(element).translate;
        if (translate && translate !== "none" &&
            translate !== "0px" && translate !== "0px 0px") continue;
        openingContentSlides.set(element, state);
      }
      const destination = element.getBoundingClientRect();
      if (state.delta === null) {
        state.delta = origin.left - destination.left;
      }
      state.offset = state.delta * (1 - progress);
      element.style.setProperty(
        "translate", `${state.offset.toFixed(3)}px 0px`, "important"
      );
    }
  }

  function clearOpeningContentOcclusion() {
    clearOpeningContentSlide();
    sharedOpeningGeometry?.tab.classList.remove("safari-v8-opening-tab");
    for (const content of openingContentMasks) {
      content.classList.remove("safari-v8-opening-occluded");
      content.style.removeProperty("--safari-v8-occlusion-start");
      content.style.removeProperty("--safari-v8-occlusion-end");
    }
    openingContentMasks.clear();
  }

  function updateOpeningContentOcclusion(left, right) {
    const retained = new Set();
    if (visible && sharedOpeningGeometry?.tab === selectedTab()) {
      for (const tab of gBrowser.tabs) {
        if (tab === sharedOpeningGeometry.tab ||
            tab.hidden || tab.closing || tab.pinned) continue;
        const content = tab.querySelector(".tab-content");
        if (!content) continue;
        const rect = content.getBoundingClientRect();
        const start = Math.max(0, left - rect.left);
        const end = Math.min(rect.width, right - rect.left);
        if (rect.width <= 0 || end <= start) continue;
        retained.add(content);
        content.classList.add("safari-v8-opening-occluded");
        for (const [name, value] of [
          ["--safari-v8-occlusion-start", start],
          ["--safari-v8-occlusion-end", end]
        ]) {
          const next = `${value.toFixed(3)}px`;
          if (content.style.getPropertyValue(name) !== next) {
            content.style.setProperty(name, next);
          }
        }
      }
    }
    for (const content of openingContentMasks) {
      if (retained.has(content)) continue;
      content.classList.remove("safari-v8-opening-occluded");
      content.style.removeProperty("--safari-v8-occlusion-start");
      content.style.removeProperty("--safari-v8-occlusion-end");
    }
    openingContentMasks.clear();
    for (const content of retained) openingContentMasks.add(content);
  }

  function positionNoScrollAddress(geometry = null) {
    geometry ||= updateNoScrollLayout();
    const tab = selectedTab();
    if (!tab) return;

    const metric = geometry?.tabGeometry.find(item => item.tab === tab);
    const rect = metric?.rect || tab.getBoundingClientRect();
    const sourceContent = tab.querySelector(".tab-content") || tab;
    setStyleProperty(
      urlbar,
      "--safari-v8-source-scheme",
      getComputedStyle(sourceContent).colorScheme
    );

    for (const name of ["--safari-v8-pill-start", "--safari-v8-pill-end"]) {
      setStyleProperty(urlbar, name, tab.style.getPropertyValue(name));
    }

    const opening = sharedOpeningGeometry;
    const targetWidth = opening?.tab === tab
      ? geometry?.editWidth
      : rect.width;
    const width = Math.max(1, targetWidth || rect.width);
    const left = opening?.tab === tab
      ? (opening.stationaryRight ?? rect.right) - width
      : rect.left;

    setPixelProperty(urlbar, "--safari-v8-left", left);
    setPixelProperty(urlbar, "--safari-v8-top", rect.top + 4);
    setPixelProperty(urlbar, "--safari-v8-width", width);
    setPixelProperty(
      urlbar,
      "--safari-v8-height",
      Math.max(1, rect.height - 8)
    );
    updateOpeningContentOcclusion(left, left + width);
    updateOpeningContentSlide();
  }

  // XUL's native [flex="1"] !important overrides userChrome flex rules.
  // Remove only the conflicting presentation attributes, restoring on cleanup.
  const noScrollFlexAttributes = new Map();
  let noScrollShadowStyle = null;

  function releaseNativeFlex(element) {
    if (!element || !element.hasAttribute("flex")) return;
    if (!noScrollFlexAttributes.has(element)) {
      noScrollFlexAttributes.set(element, element.getAttribute("flex"));
    }
    element.removeAttribute("flex");
  }

  let previousNavigationState = null;

  // Design targets, not measured Safari constants. Keep ordinary shares
  // unchanged until compression requires a readable selected tab.
  function noScrollTabAllocation(rowWidth, count, hasActive) {
    const equal = rowWidth / count;
    // Preserve counts 1-4, then shrink monotonically to the dense target.
    // A narrow row must not grow the selected tab between counts 4 and 5.
    const selected = hasActive && count > 4
      ? Math.max(equal, Math.min(240, rowWidth / 4))
      : equal;
    const ordinary = hasActive && count > 1
      ? (rowWidth - selected) / (count - 1) : equal;
    return {
      selected, ordinary,
      selectedGrow: ordinary > 0 ? selected / ordinary : 1
    };
  }

  // Presentation only: native tab allocation remains the geometry owner.
  const iconLabelReveals = new Map();

  function cancelIconLabelReveal(tab) {
    const animations = iconLabelReveals.get(tab);
    if (!animations) return;
    iconLabelReveals.delete(tab);
    for (const animation of animations) animation.cancel();
  }

  function clearIconLabelReveals() {
    for (const tab of [...iconLabelReveals.keys()]) {
      cancelIconLabelReveal(tab);
    }
  }

  function animateIconLabelReveals(origins) {
    // Read all destinations before starting any paint-only animation.
    const destinations = origins.map(({tab, icon, label, localLeft}) => ({
      tab, icon, label,
      opacity: Number.parseFloat(getComputedStyle(label).opacity),
      delta: localLeft - (icon.getBoundingClientRect().left -
        tab.getBoundingClientRect().left)
    }));
    for (const {tab, icon, label, delta, opacity} of destinations) {
      if (!Number.isFinite(delta)) continue;
      const baseOpacity = Number.isFinite(opacity) ? opacity : 1;
      // Design calibration, not a measured Safari duration.
      const timing = {
        duration: 220, easing: "cubic-bezier(.2, .8, .2, 1)"
      };
      const animations = [
        icon.animate([
          {translate: `${delta}px 0px`},
          {translate: "0px 0px"}
        ], timing),
        label.animate([
          {opacity: 0, translate: `${delta}px 0px`},
          {opacity: baseOpacity, translate: "0px 0px"}
        ], timing)
      ];
      iconLabelReveals.set(tab, animations);
      Promise.allSettled(animations.map(animation => animation.finished))
        .then(() => {
          if (lifecycle.disposed) return;
          // A superseded animation must not remove its replacement.
          if (iconLabelReveals.get(tab) === animations) {
            iconLabelReveals.delete(tab);
          }
        });
    }
  }

  function centerInactiveTabContent(tabGeometry, active) {
    /*
     * The icon-only class commit changes intrinsic content widths. This is a
     * documented endpoint flush: read every correction first, then publish.
     */
    const updates = tabGeometry.map(metric => {
      let correction = 0;
      if (tabGeometry.length > 4 && metric.tab !== active &&
          !metric.iconOnly && metric.content && metric.icon &&
          metric.labelContainer) {
        const style = getComputedStyle(metric.content);
        const leading = pixels(style.paddingLeft);
        const trailing = pixels(style.paddingRight);
        const groupWidth = metric.icon.offsetWidth +
          metric.labelContainer.offsetWidth + pixels(style.columnGap);
        const freeSpace = Math.max(
          0,
          metric.content.clientWidth - leading - trailing - groupWidth
        );
        correction = -Math.min(
          Math.max(0, (leading - trailing) / 2),
          freeSpace / 2
        );
      }
      return {tab: metric.tab, correction};
    });

    for (const update of updates) {
      setPixelProperty(
        update.tab,
        "--safari-v8-content-center",
        update.correction
      );
    }
  }

  function updateNoScrollLayout() {
    if (lifecycle.disposed) return null;

    const back = document.querySelector("#back-button");
    const forward = document.querySelector("#forward-button");
    const navigationState = [back, forward].map(button =>
      button ? `${button.hasAttribute("disabled")}:${button.hidden}` : "absent"
    ).join("|");
    const navigationStateChanged = previousNavigationState !== null &&
      previousNavigationState !== navigationState;
    previousNavigationState = navigationState;
    const navigationWidthMoving = !newTabOpening &&
      ![...gBrowser.tabs].some(tab => tab.closing ||
        tab.classList.contains("safari-v8-retiring")) &&
      (navigationStateChanged || !!back?.getAnimations().some(animation =>
        ["width", "min-width", "max-width"].includes(
          animation.transitionProperty
        ) &&
        (animation.playState === "running" ||
          animation.playState === "pending")
      ));

    const arrow = document.querySelector("#tabbrowser-arrowscrollbox");
    /*
     * Native flex removal changes the geometry being captured. This is the
     * sole preparatory write. The following rect read is an intentional layout
     * flush before the capture/derive/commit transaction begins.
     */
    const hadNativeFlex = arrow?.hasAttribute("flex");
    releaseNativeFlex(arrow);
    if (hadNativeFlex) void arrow.getBoundingClientRect();

    if (arrow?.shadowRoot && !noScrollShadowStyle) {
      noScrollShadowStyle = document.createElementNS(
        "http://www.w3.org/1999/xhtml", "style"
      );
      noScrollShadowStyle.textContent = `
        [part="scrollbutton-up"], [part="scrollbutton-down"],
        [part="overflow-start-indicator"], [part="overflow-end-indicator"] {
          display: none !important;
        }
        [part="scrollbox"], [part="items-wrapper"] {
          min-width: 0 !important;
        }
      `;
      own(() => {
        noScrollShadowStyle?.remove();
        noScrollShadowStyle = null;
      });
      arrow.shadowRoot.appendChild(noScrollShadowStyle);
      // The shadow rule changes the shelf measurement. Flush it once before
      // capturing the transaction snapshot.
      void arrow.getBoundingClientRect();
    }

    const snapshot = captureShelfMetrics({includeTabs: true});
    const geometry = deriveNoScrollGeometry(snapshot);
    if (!geometry) return null;
    geometry.snapshot = snapshot;

    /*
     * Commit phase. Measurements above are complete; publish only changed CSS
     * properties and state classes until the documented endpoint flush below.
     */
    setClassState(
      document.documentElement,
      "safari-v8-navigation-layout-follow",
      navigationWidthMoving
    );
    setClassState(
      document.documentElement,
      "safari-v8-dense-tabs",
      geometry.dense
    );
    setPixelProperty(
      tabs,
      "--safari-v8-row-width",
      geometry.paintedRowWidth
    );
    setPixelProperty(tabs, "--safari-v8-edit-width", geometry.editWidth);
    setPixelProperty(tabs, "--safari-v8-row-offset", geometry.rowOffset);

    if (snapshot.opening) {
      snapshot.opening.stationaryRight = geometry.stationaryRight;
    }

    for (const metric of geometry.tabGeometry) {
      setPixelProperty(metric.tab, "--safari-v8-tab-width", metric.width);
      setStyleProperty(
        metric.tab,
        "--safari-v8-tab-grow",
        String(metric.grow)
      );
      setPixelProperty(
        metric.tab,
        "--safari-v8-pill-start",
        metric.startInset
      );
      setPixelProperty(
        metric.tab,
        "--safari-v8-pill-end",
        metric.endInset
      );
      releaseNativeFlex(metric.labelContainer);
      setClassState(
        metric.tab,
        "safari-v8-address",
        visible && metric.tab === snapshot.active
      );
    }

    if (snapshot.presentationOpening &&
        snapshot.presentationOpening.tab !== snapshot.active) {
      return geometry;
    }

    for (const tab of [...iconLabelReveals.keys()]) {
      if (!snapshot.ordinaryTabs.includes(tab) ||
          tab === snapshot.active ||
          snapshot.newTabOpening ||
          snapshot.draggedControlTab ||
          snapshot.reduceMotion) {
        cancelIconLabelReveal(tab);
      }
    }

    const revealCandidates = [];
    for (const metric of geometry.tabGeometry) {
      if (metric.currentIconOnly === metric.iconOnly) continue;
      cancelIconLabelReveal(metric.tab);
      if (metric.currentIconOnly && !metric.iconOnly &&
          metric.tab !== snapshot.active &&
          !snapshot.newTabOpening &&
          !snapshot.draggedControlTab &&
          !snapshot.reduceMotion &&
          metric.icon && metric.labelContainer &&
          metric.iconRect?.width > 0) {
        revealCandidates.push({
          tab: metric.tab,
          icon: metric.icon,
          label: metric.labelContainer,
          localLeft: metric.iconRect.left - metric.rect.left
        });
      }
      setClassState(
        metric.tab,
        "safari-v8-icon-only",
        metric.iconOnly
      );
    }

    centerInactiveTabContent(geometry.tabGeometry, snapshot.active);
    animateIconLabelReveals(revealCandidates);
    return geometry;
  }

  function positionUrlbar(geometry = null) {
    if (lifecycle.disposed) return;
    if (noScrollLayoutEnabled()) {
      positionNoScrollAddress(geometry);
      return;
    }
    const tab = selectedTab();
    if (!tab) return;

    const rect = tab.getBoundingClientRect();
    const xGap = 0;
    const yGap = 4;
    setPixelProperty(urlbar, "--safari-v8-left", rect.left + xGap);
    setPixelProperty(urlbar, "--safari-v8-top", rect.top + yGap);
    setPixelProperty(
      urlbar,
      "--safari-v8-width",
      Math.max(1, rect.width - xGap * 2)
    );
    setPixelProperty(
      urlbar,
      "--safari-v8-height",
      Math.max(1, rect.height - yGap * 2)
    );

    if (visible) {
      clearAddressState();
      tab.classList.add("safari-v8-address");
    }
  }

  function plusButton() {
    return document.querySelector("#new-tab-button");
  }

  function rightBoundary(anchorRight) {
    const selectors = [
      "#nav-bar-overflow-button",
      "#unified-extensions-button",
      "#downloads-button",
      "#alltabs-button",
      "#PanelUI-menu-button"
    ];

    const positions = selectors
      .flatMap(selector => [...document.querySelectorAll(selector)])
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.left > anchorRight &&
          style.display !== "none" && style.visibility !== "hidden";
      })
      .map(element => element.getBoundingClientRect().left);

    return positions.length
      ? Math.min(...positions)
      : window.innerWidth - safetyGap;
  }

  function visibleAllTabsButton() {
    return [...document.querySelectorAll("#alltabs-button")].find(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden";
    }) || null;
  }


  function updatePlusPlacement() {
    if (lifecycle.disposed) return null;
    return updateNoScrollLayout();
  }


  const searchGlyph =
    "chrome://global/skin/icons/search-glass.svg";

  function isBlankNewTab(tab = selectedTab()) {
    const spec = tab?.linkedBrowser?.currentURI?.spec || "";
    return spec === "about:newtab" || spec === "about:home" || spec === "about:blank";
  }

  function selectedSuggestionGlyph() {
    if (isBlankNewTab() && input.value.length === 0) return "";

    const row =
      document.querySelector(".urlbarView-row[selected]") ||
      document.querySelector(".urlbarView-row[aria-selected='true']");

    return row?.querySelector(".urlbarView-favicon")
      ?.getAttribute("src") || "";
  }

  function selectedTabGlyph() {
    const tab = selectedTab();
    if (!tab) return "";

    return (
      (typeof gBrowser.getIcon === "function"
        ? gBrowser.getIcon(tab)
        : "") ||
      tab.image ||
      tab.getAttribute("image") ||
      tab.querySelector(".tab-icon-image")?.getAttribute("src") ||
      ""
    );
  }

  function applyGlyph(source) {
    // Suppress the actual image while close owns the address glyph slot.
    // The normal image is inline !important, so wrapper visibility alone
    // is not a sufficient image-source mask.
    const masked = glyphSlot.classList.contains("safari-v8-close-mask");
    const resolvedSource = source || searchGlyph;
    // Only the built-in search glyph accepts theme-aware context paint.
    // Favicons retain their original colors and the existing close mask.
    glyph.classList.toggle("safari-v8-search-glyph", resolvedSource === searchGlyph);
    glyph.style.setProperty(
      "list-style-image",
      masked ? "none" : `url("${resolvedSource}")`,
      "important"
    );
  }

  function resolveGlyph() {
    if (isBlankNewTab() && input.value.length === 0) return searchGlyph;

    /*
     * Firefox restores the current URL and valid page-proxy state on the first
     * Escape before it necessarily clears the selected suggestion row. Once
     * the page state is valid, the current tab favicon must therefore outrank
     * any stale prediction favicon still present in the view.
     */
    const pageState = inputContainer.getAttribute("pageproxystate") || "";
    if (pageState === "valid") {
      return selectedTabGlyph() || searchGlyph;
    }

    const suggestion = selectedSuggestionGlyph();
    if (suggestion) return suggestion;

    const wholeValueSelected =
      input.value.length > 0 &&
      input.selectionStart === 0 &&
      input.selectionEnd === input.value.length;

    if (wholeValueSelected) {
      return selectedTabGlyph() || searchGlyph;
    }

    return searchGlyph;
  }

  function hideCleanGlyph() {
    glyph.style.removeProperty("opacity");
  }


  function updateCleanGlyph() {
    if (lifecycle.disposed) return;
    glyph.style.removeProperty("opacity");
  }

  function refreshAddressControls() {
    if (!visible || newTabOpening) return;
    if (closeHover) positionCloseButton();
    if (reloadHover) positionReloadButton();
  }

  function onAddressInput() {
    if (lifecycle.disposed) return;
    // Input may precede Firefox's usertyping attribute update.
    hideReload();
    updateGlyph();
  }

  function updateGlyph() {
    if (lifecycle.disposed) return;
    scheduler.cancelFrame("glyph");
    if (!visible || !urlbar.classList.contains("safari-v8-visible")) return;

    applyGlyph(resolveGlyph());

    scheduler.scheduleMicrotask(() => {
      if (!visible) return;
      applyGlyph(resolveGlyph());
      updateCleanGlyph();
    });

    scheduler.scheduleFrame("glyph", () => {
      if (!visible) return;
      applyGlyph(resolveGlyph());
      updateCleanGlyph();
      refreshAddressControls();
    });
  }


  function positionShelfGeometryProbe(snapshot = null) {
    if (lifecycle.disposed) return;
    const captured = snapshot || captureShelfMetrics();
    const rect = captured.arrowRect;
    const tabRect = captured.active?.getBoundingClientRect();

    if (!rect || !tabRect || rect.width <= 0) {
      setClassState(shelfProbe, "visible", false);
      return;
    }

    setPixelProperty(shelfProbe, "--probe-left", rect.left);
    setPixelProperty(shelfProbe, "--probe-top", tabRect.top + 4);
    setPixelProperty(shelfProbe, "--probe-width", rect.width);
    setPixelProperty(
      shelfProbe,
      "--probe-height",
      Math.max(1, tabRect.height - 8)
    );
    shelfProbe.classList.remove("continues-before", "continues-after");
    setClassState(shelfProbe, "address-mode", visible);
    setClassState(shelfProbe, "visible", true);
  }

  function followShelfGeometryAnimation(duration = 210) {
    if (lifecycle.disposed) return;
    const token = ++shelfProbeAnimationToken;
    const started = performance.now();
    scheduler.cancelFrame("shelf-follow");

    const tick = now => {
      if (token !== shelfProbeAnimationToken) return;
      const geometry = noScrollLayoutEnabled()
        ? updateNoScrollLayout()
        : null;
      if (geometry) positionUrlbar(geometry);
      positionShelfGeometryProbe(geometry?.snapshot);

      if (now - started < duration) {
        scheduler.scheduleFrame("shelf-follow", tick);
      } else {
        positionShelfGeometryProbe();
      }
    };

    scheduler.scheduleFrame("shelf-follow", tick);
  }

  function render() {
    if (lifecycle.disposed) return;
    scheduler.scheduleFrame("render", () => {
      /*
       * Firefox owns the complete native new-tab flex animation. Rendering the
       * address transaction from ResizeObserver or focus events during that
       * interval was the source of the frame-by-frame plus-button movement.
       */
      if (newTabOpening) return;

      updateAllSafariDisplayLabels();
      const geometry = updatePlusPlacement();
      positionUrlbar(geometry);
      updateGlyph();

      /*
       * Fixed visual layers receive their own exact FLIP animation.
       * Address and shelf publication share the same captured transaction;
       * do not recapture geometry between their commits.
       */
      positionShelfGeometryProbe(geometry?.snapshot);
      followShelfGeometryAnimation();
      updateCleanGlyph();

      if (closeHover) {
        positionCloseButton();
      }

      if (reloadHover) {
        positionReloadButton();
      }
    });
  }

  function settle() {
    if (lifecycle.disposed) return;
    scheduler.cancelTimer("settle");
    render();
    scheduler.scheduleTimer("settle", render, 120);
  }

  function revealSelectedAddressFromStart() {
    if (lifecycle.disposed) return;
    input.scrollLeft = 0;

    scheduler.scheduleFrame("reveal-address", () => {
      input.scrollLeft = 0;
      scheduler.scheduleTimer("reveal-address-timeout", () => {
        input.scrollLeft = 0;
      }, 0);
    });
  }

  function openUrlbar() {
    if (lifecycle.disposed) return;
    const tab = selectedTab();
    if (!tab) return;

    /*
     * Cmd+L on an address surface already owned by this tab is focus-only.
     * Re-measuring or reapplying expansion here made every invocation able to
     * change the source width and the new-tab button position.
     */
    if (visible && addressOwner === tab) {
      // An already focused, fully selected address needs no second transaction.
      if (document.activeElement === input &&
          input.selectionStart === 0 &&
          input.selectionEnd === input.value.length) {
        return;
      }
      gURLBar.focus();
      gURLBar.select();
      revealSelectedAddressFromStart();
      updateGlyph();
      return;
    }


    /*
     * Establish expansion from one stable compact width, then scroll the
     * measured expanded rectangle into view before the next painted frame.
     */
    const contentOrigin = noScrollLayoutEnabled()
      ? tab.querySelector(".tab-icon-stack")?.getBoundingClientRect()
      : null;
    if (noScrollLayoutEnabled()) cancelContentHandoff();
    setVisible(true);
    positionUrlbar();
    updateNoScrollLayout();
    positionUrlbar();
    updateGlyph();

    if (noScrollLayoutEnabled() && contentOrigin?.width > 0) {
      const destination = glyph.getBoundingClientRect();
      const delta = contentOrigin.left + contentOrigin.width / 2 -
        destination.left - destination.width / 2;
      // Extend the focus handoff's braking without changing tab opening.
      const timing = {
        duration: 220, easing: "cubic-bezier(.16, 1, .3, 1)"
      };
      animateContentHandoff(glyphSlot, delta, timing);
      animateContentHandoff(
        urlbar.querySelector(".urlbar-input-box") || input, delta, timing
      );
    }

    scheduler.scheduleFrame("address-focus", () => {
      if (noScrollLayoutEnabled() && (
        !visible || addressOwner !== tab ||
        selectedTab() !== tab || tab.closing || tab.hidden
      )) return;
      gURLBar.focus();
      gURLBar.select();
      revealSelectedAddressFromStart();
      updateGlyph();
      });
  }

  function retireAddressPresentation() {
    visible = false;
    addressOwner = null;
    document.documentElement.classList.remove(
      "safari-v8-address-active", "safari-v8-opening-reserve"
    );
    urlbar.classList.remove(
      "safari-v8-visible", "safari-v8-newtab-enter",
      "safari-v8-exact-close-hover"
    );
    glyphSlot.classList.remove("safari-v8-close-mask");
  }

  function closeUrlbar() {
    if (lifecycle.disposed) return;
    document.documentElement.classList.remove(
      "safari-v8-opening-reserve"
    );
    const tab = selectedTab();
    const wasVisible = visible;
    const previousAddressOwner = addressOwner;
    const contentOrigin = noScrollLayoutEnabled() && wasVisible
      ? glyph.getBoundingClientRect() : null;
    if (noScrollLayoutEnabled()) cancelContentHandoff();
    hideCleanGlyph();
    setVisible(false);
    positionShelfGeometryProbe();
    followShelfGeometryAnimation();

    if (noScrollLayoutEnabled() && wasVisible && tab) {
      // Address motion belongs only to its owning tab.
      if (previousAddressOwner !== tab || tab.closing || tab.hidden) {
        return;
      }
      const icon = tab.querySelector(".tab-icon-stack");
      const destination = icon?.getBoundingClientRect();
      if (contentOrigin?.width > 0 && destination?.width > 0) {
        animateContentHandoff(
          tab.querySelector(".tab-content"),
          contentOrigin.left + contentOrigin.width / 2 -
            destination.left - destination.width / 2
        );
      }
      return;
    }

    if (wasVisible && tab && !newTabOpening) {
      tab.classList.remove("safari-v8-content-return");
      void tab.getBoundingClientRect();
      tab.classList.add("safari-v8-content-return");
      scheduler.scheduleOneShotTimer(
        () => tab.classList.remove("safari-v8-content-return"),
        140
      );
    }
  }

  /*
   * Fixed controls are paint-time overlays, not owners of tab allocation.
   * They intentionally sample the current transformed paint rect on demand so
   * native drag and close animations remain Firefox-owned.
   */
  function controlTargetRect() {
    if (draggedControlTab) return tabPaintRect(draggedControlTab);
    if (tabCloseTarget && tabCloseTarget !== selectedTab()) {
      return tabPaintRect(tabCloseTarget);
    }
    if (visible) return urlbar.getBoundingClientRect();
    return tabPaintRect(tabCloseTarget);
  }

  function updateControlColor(tab = controlTargetTab()) {
    const label = tab?.querySelector(".tab-label");
    const color = label
      ? getComputedStyle(label).color
      : getComputedStyle(input).color;

    if (!color) return;

    closeButton.style.setProperty("--safari-v8-control-color", color);
    reloadButton.style.setProperty("--safari-v8-control-color", color);
  }

  function positionCloseButton() {
    const rect = controlTargetRect();
    if (!rect) return;

    updateControlColor();

    const size = 18;
    const target = controlTargetTab();
    const addressTarget = !draggedControlTab &&
      visible && target === addressOwner;
    // Ordinary hover belongs to the leading edge, not the centered favicon.
    // Only address hover replaces the actual address glyph.
    // Use the stationary slot, not the animated glyph's viewport rect.
    const surface = addressTarget
      ? inputContainer.getBoundingClientRect() : null;
    const iconRect = noScrollLayoutEnabled() && surface
      ? {
          left: surface.left +
            (parseFloat(getComputedStyle(inputContainer).paddingLeft) || 0),
          top: surface.top,
          width: 28,
          height: surface.height
        }
      : null;
    // Refresh ownership and masking even without a pointermove event.
    if (closeHover) {
      urlbar.classList.toggle("safari-v8-exact-close-hover", addressTarget);
      glyphSlot.classList.toggle("safari-v8-close-mask", addressTarget);
      applyGlyph(resolveGlyph());
    }
    let centerX = iconRect?.width > 0
      ? iconRect.left + iconRect.width / 2
      : rect.left + (addressTarget ? 20 : 18);
    if (noScrollLayoutEnabled() && !addressTarget &&
        target?.classList.contains("safari-v8-icon-only")) {
      const favicon = target.querySelector(".tab-icon-stack")
        ?.getBoundingClientRect();
      if (favicon?.width > 0) {
        // Preserve a 3px gap between the 18px close target and favicon.
        // A tab narrower than both controls physically cannot fit both.
        centerX = Math.max(rect.left + size / 2,
          Math.min(centerX, favicon.left - size / 2 - 3));
      }
    }
    const centerY = iconRect?.height > 0
      ? iconRect.top + iconRect.height / 2
      : rect.top + rect.height / 2;

    setPixelProperty(closeButton, "--close-left", centerX - size / 2);
    setPixelProperty(closeButton, "--close-top", centerY - size / 2);

    if (!visible && tabCloseTarget) {
      /*
       * The compact grid permanently reserves a leading control slot.
       * Favicon and label must remain unchanged when the close control appears.
       */
      tabCloseTarget.classList.remove("safari-v8-close-over-icon");
    }
    if (noScrollLayoutEnabled() && target) {
      // The centered favicon remains visible during ordinary leading-edge hover.
      target.classList.remove("safari-v8-close-over-icon");
    }
  }

  function showClose(tab = null) {
    // Ownership must follow the requested tab even while another address is open.
    if (tabCloseTarget !== tab) {
      tabCloseTarget?.classList.remove("safari-v8-close-over-icon");
    }
    tabCloseTarget = tab;
    closeHover = true;
    positionCloseButton();
    const addressTarget = visible &&
      (!noScrollLayoutEnabled() || controlTargetTab() === addressOwner);
    urlbar.classList.toggle("safari-v8-exact-close-hover", addressTarget);
    glyphSlot.classList.toggle("safari-v8-close-mask", addressTarget);
    // Apply the source mask synchronously, before the close button paints.
    applyGlyph(resolveGlyph());

    if (addressTarget) {

      /*
       * The clean glyph is painted above the compositing surface and would
       * otherwise cover the fixed close control. Hide it synchronously when
       * close hover begins.
       */
      hideCleanGlyph();
    }

    closeButton.classList.add("visible");
  }

  // Fixed controls follow the dragged tab's painted native transform.
  let draggedControlTab = null;
  let draggedControlEnding = false;
  let draggedControlDeadline = 0;

  function stopDraggedControls() {
    scheduler.cancelFrame("drag-follow");
    draggedControlTab = null;
    draggedControlEnding = false;
    document.querySelector("#tabbrowser-arrowscrollbox")
      ?.classList.remove("safari-v8-drag-shelf-clip");
    for (const control of [closeButton, reloadButton]) {
      control.classList.remove("safari-v8-drag-control-clip");
      control.style.removeProperty("--safari-v8-drag-clip-left");
      control.style.removeProperty("--safari-v8-drag-clip-right");
    }
  }

  // Keep native transfer/adoption, but show the lone tab rather than a
  // page thumbnail. Intercept both image calls because native capture updates
  // the drag image asynchronously after startTabDrag has returned.
  const nativeDragOwner = tabs.tabDragAndDrop;
  const originalStartTabDrag = nativeDragOwner?.startTabDrag;

  // The centered shelf leaves a large empty leading margin. Native drag-to-pin
  // interprets that margin as a pin target, expands the indicator and locks
  // the tab container's maxWidth. Disable that cue at its activation point,
  // not merely its paint, while preserving native drop/reset and menu pinning.
  const originalCheckPinnedBounds =
    nativeDragOwner?._checkWithinPinnedContainerBounds;
  function checkPinnedBoundsWithoutCompactCue(...args) {
    if (noScrollLayoutEnabled() && !tabs.verticalMode) {
      const indicator = this._pinnedDropIndicator;
      indicator?.removeAttribute("visible");
      indicator?.removeAttribute("interactive");
      return;
    }
    return originalCheckPinnedBounds.apply(this, args);
  }
  function startTabDragWithLoneTabImage(event, tab, options = {}) {
    if (!noScrollLayoutEnabled() || tabs.verticalMode || tabs._isCustomizing ||
        options.fromTabList || !tab?.matches?.(".tabbrowser-tab") ||
        tab.pinned || tab.hidden || tab.closing || tab.splitview ||
        !tab.isConnected || !event.dataTransfer ||
        [...gBrowser.tabs].filter(item => !item.hidden && !item.closing)
          .length !== 1) {
      return originalStartTabDrag.call(this, event, tab, options);
    }

    const rect = tab.getBoundingClientRect();
    const offsetX = Math.round(Math.max(
      0, Math.min(rect.width, event.clientX - rect.left)
    ));
    const offsetY = Math.round(Math.max(
      0, Math.min(rect.height, event.clientY - rect.top)
    ));
    const transfer = new Proxy(event.dataTransfer, {
      get(target, key) {
        if (key === "setDragImage" || key === "updateDragImage") {
          return (image, x, y) => {
            if (tab.isConnected && !tab.closing) {
              return target[key](tab, offsetX, offsetY);
            }
            return target[key](image, x, y);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, key, value) {
        return Reflect.set(target, key, value, target);
      }
    });
    const projected = new Proxy(event, {
      get(target, key) {
        if (key === "dataTransfer") return transfer;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    // A lone tab has nothing to reorder in its source window. Use the
    // native non-strip transfer path: keep the source stationary and show
    // the independent drag image from dragstart, without movingtab mode.
    // Native drop/adoption and dragend still own landing and cancellation.
    return originalStartTabDrag.call(this, projected, tab, {
      ...options,
      fromTabList: true
    });
  }

  function startDraggedControls(event) {
    if (lifecycle.disposed) return;
    const tab = event.target.closest?.(".tabbrowser-tab");
    if (!noScrollLayoutEnabled() || !tab ||
        tab.hidden || tab.closing) return;
    stopDraggedControls();
    draggedControlTab = tab;
    tabCloseTarget = tab;
    const row = document.querySelector("#tabbrowser-arrowscrollbox");
    row?.classList.add("safari-v8-drag-shelf-clip");
    const follow = () => {
      const owner = draggedControlTab;
      if (!owner || !owner.isConnected || owner.closing ||
          owner.hidden || (draggedControlEnding &&
          performance.now() >= draggedControlDeadline)) {
        stopDraggedControls();
        return;
      }
      // Root-level fixed controls do not inherit the row's paint clip.
      // This direct per-frame paint read follows Firefox's native transformed
      // drag surface; it does not own or alter no-scroll allocation geometry.
      const rect = tabPaintRect(owner);
      const shelf = row?.getBoundingClientRect();
      const clipControl = (control, left) => {
        const start = shelf ? Math.min(18, Math.max(0, shelf.left - left)) : 18;
        const end = shelf ? Math.min(18, Math.max(0, left + 18 - shelf.right)) : 0;
        for (const [name, value] of [
          ["--safari-v8-drag-clip-left", start],
          ["--safari-v8-drag-clip-right", end]
        ]) {
          const next = `${value.toFixed(3)}px`;
          if (control.style.getPropertyValue(name) !== next) {
            control.style.setProperty(name, next);
          }
        }
        control.classList.add("safari-v8-drag-control-clip");
      };
      clipControl(closeButton, rect.left + 9);
      clipControl(reloadButton, rect.right - 32);
      const setCoordinate = (element, name, value) => {
        const next = `${value}px`;
        if (element.style.getPropertyValue(name) !== next) {
          element.style.setProperty(name, next);
        }
      };
      if (closeHover) {
        setCoordinate(closeButton, "--close-left", rect.left + 9);
        setCoordinate(closeButton, "--close-top",
          rect.top + rect.height / 2 - 9);
      }
      if (reloadHover) {
        if (owner === selectedTab()) {
          setCoordinate(reloadButton, "--reload-left", rect.right - 32);
          setCoordinate(reloadButton, "--reload-top",
            rect.top + rect.height / 2 - 9);
        } else {
          hideReload();
        }
      }
      scheduler.scheduleFrame("drag-follow", follow);
    };
    scheduler.scheduleFrame("drag-follow", follow);
  }

  // Native reordering only receives dragover while the pointer targets tabs.
  // Extend below the shelf by three row heights; distant detach stays native.
  function forwardShelfDrag(event) {
    if (lifecycle.disposed) return;
    if (!noScrollLayoutEnabled() || !draggedControlTab ||
        draggedControlEnding || tabs.verticalMode || tabs._isCustomizing ||
        draggedControlTab.pinned || draggedControlTab.hidden ||
        draggedControlTab.closing || !draggedControlTab.isConnected ||
        tabs.contains(event.target)) return;

    const native = tabs.tabDragAndDrop;
    const data = draggedControlTab._dragData;
    const row = document.querySelector("#tabbrowser-arrowscrollbox");
    if (!native || !data || data.fromTabList || !row) return;

    // Never intercept links, copies, foreign tabs, or unrelated drag sessions.
    const transfer = event.dataTransfer;
    try {
      if (!transfer || transfer.mozGetDataAt(
        "application/x-moz-tabbrowser-tab", 0
      ) !== draggedControlTab ||
          native.getDropEffectForTabDrag(event) !== "move") return;
    } catch {
      return;
    }

    const rect = row.getBoundingClientRect();
    const tolerance = rect.height / 2;
    if (rect.width <= 0 || rect.height <= 0 ||
        event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top - tolerance ||
        event.clientY > rect.bottom + rect.height * 3) return;

    // Keep native horizontal animation and landing as the sole geometry owner.
    // Project only the cross-axis and target; retain the real transfer/modifiers
    // and bind Event methods to their original receiver.
    const projected = new Proxy(event, {
      get(target, key) {
        if (key === "target" || key === "originalTarget") return row;
        if (key === "screenY") return data.screenY;
        if (key === "clientY") return rect.top + rect.height / 2;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    if (event.type === "dragover") {
      transfer.dropEffect = "move";
      native.handle_dragover(projected);
    } else {
      event.preventDefault();
      native.handle_drop(projected);
    }
  }

  function finishDraggedControls() {
    if (!draggedControlTab) return;
    // Sampling window only; do not change native landing duration.
    draggedControlEnding = true;
    draggedControlDeadline = performance.now() + 340;
  }

  function controlTargetTab() {
    return draggedControlTab || tabCloseTarget || selectedTab();
  }

  /*
   * Reload is the trailing paint-time overlay counterpart to close. Its direct
   * rect sample follows native transforms and never publishes shelf geometry.
   */
  function reloadTargetRect() {
    if (draggedControlTab) return tabPaintRect(draggedControlTab);
    if (tabCloseTarget && tabCloseTarget !== selectedTab()) {
      return tabPaintRect(tabCloseTarget);
    }
    if (visible) return urlbar.getBoundingClientRect();
    return tabPaintRect(tabCloseTarget);
  }

  function canReloadSelectedTab() {
    const tab = controlTargetTab();
    const spec = tab?.linkedBrowser?.currentURI?.spec || "";
    const hovered = Boolean(tab?.matches(":hover")) ||
      (visible && tab === addressOwner && urlbar.matches(":hover")) ||
      (closeHover && closeButton.matches(":hover")) ||
      (reloadHover && reloadButton.matches(":hover"));
    return Boolean(tab) && tab === selectedTab() && hovered &&
      !(visible && urlbar.hasAttribute("usertyping")) &&
      spec !== "about:newtab" &&
      spec !== "about:home" &&
      spec !== "about:blank";
  }

  function positionReloadButton() {
    if (!canReloadSelectedTab()) {
      hideReload();
      return;
    }
    const rect = reloadTargetRect();
    if (!rect) {
      hideReload();
      return;
    }

    updateControlColor();
    const size = 18;
    const centerX = rect.right - 23;
    const centerY = rect.top + rect.height / 2;
    setPixelProperty(
      reloadButton,
      "--reload-left",
      centerX - size / 2
    );
    setPixelProperty(
      reloadButton,
      "--reload-top",
      centerY - size / 2
    );
  }

  function showReload() {
    /*
     * Reload belongs exclusively to the selected tab. Inactive-tab hover
     * keeps its full trailing label area and can never leave an invisible
     * reload hit target behind.
     */
    if (
      controlTargetTab() !== selectedTab() ||
      !canReloadSelectedTab()
    ) {
      hideReload();
      return;
    }

    reloadHover = true;
    positionReloadButton();
    if (reloadHover) reloadButton.classList.add("visible");
  }

  function onPointerMove(event) {
    if (lifecycle.disposed) return;
    // Drag ownership must not follow tabs crossed by the pointer.
    if (draggedControlTab) return;
    const onClose =
      event.target === closeButton || closeButton.contains(event.target);
    const onReload =
      event.target === reloadButton || reloadButton.contains(event.target);

    const hoveredTab =
      event.target.closest?.(".tabbrowser-tab:not([pinned])");

    const validTab = Boolean(
      hoveredTab && !hoveredTab.hidden && !hoveredTab.closing
    );

    if (visible) {
      const rect = urlbar.getBoundingClientRect();
      const insideUrlbar =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;

      /*
       * A real tab under the pointer takes precedence over address controls.
       * This keeps all other tabs interactive while address editing remains
       * active.
       */
      if (validTab) {
        if (hoveredTab !== tabCloseTarget) {
          tabCloseTarget?.classList.remove(
            "safari-v8-close-over-icon"
          );
          tabCloseTarget = hoveredTab;
        }

        showClose(tabCloseTarget);
        showReload();
        return;
      }

      /*
       * Fixed controls remain associated with their current target while the
       * pointer moves from the target surface onto the control itself.
       */
      if ((onClose || onReload) && tabCloseTarget) {
        if (onClose) {
          showClose(tabCloseTarget);
          hideReload();
        } else {
          hideClose();
          showReload();
        }
        return;
      }

      /*
       * Inside the address surface, controls target the selected tab.
       */
      if (insideUrlbar) {
        tabCloseTarget = null;
        const leading = event.clientX <= rect.left + 40;

        if (noScrollLayoutEnabled() || leading) {
          showClose();
          hideReload();
        } else {
          hideClose();
          showReload();
        }
        return;
      }

      hideClose();
      hideReload();
      tabCloseTarget?.classList.remove("safari-v8-close-over-icon");
      tabCloseTarget = null;
      return;
    }

    if (validTab && hoveredTab !== tabCloseTarget) {
      tabCloseTarget?.classList.remove("safari-v8-close-over-icon");
      tabCloseTarget = hoveredTab;
    }

    const keep = Boolean(
      validTab || ((onClose || onReload) && tabCloseTarget)
    );

    if (keep) {
      showClose(tabCloseTarget);
      showReload();
      return;
    }

    hideClose();
    hideReload();
    tabCloseTarget?.classList.remove("safari-v8-close-over-icon");
    tabCloseTarget = null;
  }

  function blockClosePress(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function closeSelectedTab(event) {
    blockClosePress(event);
    const tab = controlTargetTab();
    if (!tab) return;
    hideClose();
    tabCloseTarget = null;
    gBrowser.removeTab(tab, { animate: true, byMouse: true });
  }

  function blockReloadPress(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function reloadSelectedTab(event) {
    blockReloadPress(event);
    const tab = controlTargetTab();
    if (!tab || !canReloadSelectedTab()) return;

    hideReload();
    if (typeof gBrowser.reloadTab === "function") {
      gBrowser.reloadTab(tab);
    } else {
      tab.linkedBrowser.reload();
    }
  }

  function onTabPointerDown(event) {
    selectedTabClickCandidate = null;

    if (
      event.button !== 0 ||
      event.target.closest?.(".tab-close-button")
    ) {
      return;
    }

    /*
     * Capture before Firefox changes selected tab, navigation history or
     * toolbar geometry. This also catches the new-tab button because its
     * pointer event passes through the tab strip.
     */

    const tab = event.target.closest?.(".tabbrowser-tab");

    /*
     * Record whether this tab was already selected before Firefox processes
     * the click. Do not change focus, visibility or geometry here.
     */
    if (tab && tab === gBrowser.selectedTab) {
      selectedTabClickCandidate = tab;
    }
  }

  function onTabClick(event) {
    const tab = event.target.closest?.(".tabbrowser-tab");
    const wasAlreadySelected =
      tab &&
      tab === selectedTabClickCandidate &&
      tab === gBrowser.selectedTab;

    selectedTabClickCandidate = null;

    if (
      event.button !== 0 ||
      event.target.closest?.(".tab-close-button")
    ) {
      return;
    }

    /*
     * First click selects an inactive tab. Only a separate second click on
     * an already selected tab opens and highlights the address field.
     */
    if (wasAlreadySelected && !visible) {
      openUrlbar();
    }
  }

  function onTabSelect() {
    if (lifecycle.disposed) return;
    if (noScrollLayoutEnabled()) {
      cancelContentHandoff();
      const opening = sharedOpeningGeometry;
      if (newTabOpening && opening) {
        if (opening.tab === selectedTab()) {
          // TabOpen can paint before Firefox commits selection. Transfer ownership
          // at selection rather than at animation completion.
          if (visible && addressOwner !== opening.tab) setVisible(true);
        } else {
          // A real selection away retires the transaction synchronously.
          // Its queued focus and geometry callbacks must not reclaim paint.
          scheduler.cancelFrame("opening-geometry");
          newTabGeometryToken += 1;
          clearOpeningContentOcclusion();
          sharedOpeningGeometry = null;
          document.documentElement.classList.remove("safari-v8-opening-clock");
          newTabOpening = false;
        }
      }
      // Retire the old overlay before another tab can paint beneath it.
      if (!newTabOpening && addressOwner !== selectedTab()) {
        hideCleanGlyph();
        setVisible(false);
      }
      updateNoScrollLayout();
      positionUrlbar();
      positionShelfGeometryProbe();
      followShelfGeometryAnimation();
    }
    updateSafariDisplayLabel(selectedTab());

    /*
     * TabSelect fires after Firefox has committed the new navigation-button
     * geometry. Measure synchronously before the browser paints the reflow.
     */

    scheduler.scheduleMicrotask(() => {
      if (newTabOpening) return;
      // TabSelect may finish after TabOpen's address ownership transaction.
      // Do not retire the new tab's already focused address surface.
      const focused = document.activeElement;
      if (visible && addressOwner === selectedTab() &&
          (focused === input || urlbar.contains(focused))) {
        settle();
        return;
      }
      closeUrlbar();
      settle();
    });
  }

  function onFocusIn(event) {
    if (lifecycle.disposed) return;
    if (
      newTabOpening ||
      (event.target !== input && !urlbar.contains(event.target))
    ) {
      return;
    }

    if (noScrollLayoutEnabled() && visible &&
        addressOwner !== selectedTab()) return;
    setVisible(true);
    render();
  }

  function onFocusOut() {
    if (lifecycle.disposed) return;
    scheduler.scheduleFrame("focus-out", () => {
      if (newTabOpening) return;

      const focused = document.activeElement;
      if (focused !== input && !urlbar.contains(focused)) {
        closeUrlbar();
      }
    });
  }

  function onKeyDown(event) {
    if (
      event.metaKey &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      event.key.toLowerCase() === "t"
    ) {
      restoreTabCommandPending = true;
      scheduler.scheduleTimer("restore-tab-command", () => {
        restoreTabCommandPending = false;
      }, 1000);
      return;
    }

    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      event.stopImmediatePropagation();
      openUrlbar();
    }
  }

  function finishStableNewTab(openedTab, token) {
    if (lifecycle.disposed) return;
    if (
      token !== newTabGeometryToken ||
      openedTab !== gBrowser.selectedTab ||
      openedTab.closing ||
      openedTab.hidden
    ) {
      return;
    }

    /*
     * Commit the final expansion once, after Firefox's native tab width has
     * stabilized. Retain the proven pre-shortening expansion, plus placement,
     * shelf and ownership logic unchanged.
     */
    clearOpeningContentOcclusion();
    sharedOpeningGeometry = null;
    document.documentElement.classList.remove("safari-v8-opening-clock");
    newTabOpening = false;
    // TabOpen can precede native selection: its initial address owner may
    // still be the previous tab. Commit ownership to the validated new tab
    // before finishing geometry, so Cmd+L cannot reopen the same surface.
    if (visible && addressOwner !== openedTab) {
      setVisible(true);
    }
    updatePlusPlacement(true);
    positionUrlbar();
    urlbar.classList.add("safari-v8-newtab-enter");
    void urlbar.getBoundingClientRect();
    document.documentElement.classList.remove(
      "safari-v8-opening-reserve"
    );
    positionUrlbar();
    positionShelfGeometryProbe();
    /*
     * Follow the same painted address/plus bounds throughout Safe Push.
     * A separate shelf FLIP would animate an already-moving target twice.
     */
    followShelfGeometryAnimation();
    applyGlyph(searchGlyph);
    updateGlyph();

    // Opening motion belongs to shared geometry, not a trailing
    // decorative content animation.
  }

  function waitForStableNewTabGeometry(openedTab, token) {
    if (lifecycle.disposed) return;
    scheduler.cancelFrame("opening-geometry");
    if (noScrollLayoutEnabled()) {
      const sample = () => {
        if (token !== newTabGeometryToken) return;
        if (openedTab !== selectedTab() || openedTab.pinned) {
          clearOpeningContentOcclusion();
          sharedOpeningGeometry = null;
          document.documentElement.classList.remove("safari-v8-opening-clock");
          newTabOpening = false;
          render();
          return;
        }

        // Flush native style before reading its transition. Never write fadein
        // or call Firefox's private completion methods.
        void openedTab.getBoundingClientRect();
        const animation = openedTab.getAnimations().find(
          item => item.transitionProperty === "flex-grow"
        );
        const progress = animation?.effect?.getComputedTiming().progress;
        const fadedIn = openedTab.hasAttribute("fadein");
        const reduced = window.matchMedia(
          "(prefers-reduced-motion: reduce)"
        ).matches;
        const opening = sharedOpeningGeometry;
        if (opening) {
          opening.progress = reduced ? 1 :
            typeof progress === "number" ? progress : fadedIn ? 1 : 0;
        }

        positionUrlbar();
        positionShelfGeometryProbe();
        if (fadedIn && (!animation || reduced ||
            animation.playState === "finished")) {
          finishStableNewTab(openedTab, token);
          return;
        }
        scheduler.scheduleFrame("opening-geometry", sample);
      };
      scheduler.scheduleFrame("opening-geometry", sample);
      return;
    }

  }


  // Native replenishment normally waits for the opening transition.
  // Refill after the current tab-creation transaction instead, so a rapid
  // second Cmd+T can consume prepared content. Native policy/counts still
  // decide whether a preload may be created.
  function replenishNewTabPreload(openedTab) {
    if (lifecycle.disposed) return;
    if (!noScrollLayoutEnabled() || !openedTab?.isConnected ||
        openedTab.closing || !openedTab.linkedPanel ||
        gBrowser.preloadedBrowser || window.closed) return;
    try {
      const { NewTabPagePreloading } = ChromeUtils.importESModule(
        "moz-src:///browser/components/tabbrowser/NewTabPagePreloading.sys.mjs"
      );
      NewTabPagePreloading.maybeCreatePreloadedBrowser(window);
    } catch (error) {
      console.error("Safari Compact: native new-tab preload failed", error);
    }
  }

  function onTabOpen(event) {
    if (lifecycle.disposed) return;

    const openedTab = event.target;
    const restoringClosedTab = restoreTabCommandPending;
    scheduler.cancelTimer("restore-tab-command");
    restoreTabCommandPending = false;

    /*
     * Startup tabs and tabs restored by Cmd+Shift+T are state reconciliation,
     * not interactive new-tab transactions. Firefox commits restored identity
     * state after TabOpen, so address ownership and glyph seeding must not start.
     */
    if (!gBrowserInit.delayedStartupFinished || restoringClosedTab) {
      retireAddressPresentation();
      scheduler.scheduleMicrotask(() => {
        if (!openedTab.isConnected || openedTab.closing) return;
        updateNoScrollLayout();
        updateSafariDisplayLabel(openedTab);
        updateAllSafariDisplayLabels();
        settle();
      });
      return;
    }

    clearIconLabelReveals();
    // Capture painted content before retiring a superseded opening.
    const openingCount = [...gBrowser.tabs].filter(
      tab => !tab.hidden && !tab.closing && !tab.pinned
    ).length;
    const contentOrigins = noScrollLayoutEnabled() &&
      openingCount >= 6 && visible && addressOwner === selectedTab()
      ? [glyphSlot, urlbar.querySelector(".urlbar-input-box") || input]
        .filter(Boolean)
        .map(element => ({
          element, left: element.getBoundingClientRect().left
        }))
      : null;
    // Hover ownership and fixed control coordinates cannot cross a TabOpen
    // transaction while geometry is changing.
    hideClose();
    hideReload();
    tabCloseTarget = null;
    cancelContentHandoff();
    scheduler.cancelFrame("opening-geometry");

    // TabOpen precedes native load/selection initialization. Do not create
    // another browser reentrantly inside that unfinished transaction.
    scheduler.scheduleMicrotask(() => replenishNewTabPreload(openedTab));
    const token = ++newTabGeometryToken;
    clearOpeningContentOcclusion();
    sharedOpeningGeometry = null;
    document.documentElement.classList.remove("safari-v8-opening-clock");
    if (noScrollLayoutEnabled() && !openedTab.pinned) {
      const shelf = captureShelfMetrics();
      const rect = shelf.arrowRect;
      const available = Math.max(
        0,
        shelf.containerRect.width -
          shelf.paddingLeft -
          shelf.paddingRight -
          shelf.pinnedWidth
      );
      if (rect && rect.width > 0) {
        sharedOpeningGeometry = {
          tab: openedTab, left: rect.left, width: rect.width, progress: 0,
          fullShelf: openingCount > 4 && available > 0 &&
            Math.abs(rect.width - available) <= 1,
          contentOrigins
        };
        openedTab.classList.add("safari-v8-opening-tab");
        document.documentElement.classList.add("safari-v8-opening-clock");
      }
    }
    newTabOpening = true;
    /*
     * Replace Firefox's native "Ny flik" face inside TabOpen, before the next
     * painted frame. The real URL field follows the native opening width with
     * zero extension; the recovered expansion and plus-button geometry are
     * committed only when the row is stable.
     */
    hideCleanGlyph();
    urlbar.classList.remove("safari-v8-newtab-enter");
    // Reserve and anchor the plus before native opening starts painting.
    // Waiting until finishStableNewTab replayed an already-pushed position.
    updatePlusPlacement();
    updateSafariDisplayLabel(openedTab);
    setVisible(true);

    const openingGeometry = updateNoScrollLayout();
    positionUrlbar(openingGeometry);
    positionShelfGeometryProbe(openingGeometry?.snapshot);
    applyGlyph(searchGlyph);

    // TabOpen precedes native selection and browser-load initialization.
    // Focus only after the transaction identifies the still-current
    // opening tab.
    scheduler.scheduleMicrotask(() => {
      if (
        token !== newTabGeometryToken ||
        openedTab !== selectedTab()
      ) return;
      gURLBar.focus();
      gURLBar.select();
      revealSelectedAddressFromStart();
    });

    waitForStableNewTabGeometry(openedTab, token);
  }

  function onTabClose(event) {
    if (lifecycle.disposed) return;
    cancelIconLabelReveal(event.target);
    // Retire the opening transaction before close callbacks can reuse its
    // partial row allocation. A stale RAF must not finish a closing tab.
    if (sharedOpeningGeometry?.tab === event.target) {
      scheduler.cancelFrame("opening-geometry");
      newTabGeometryToken += 1;
      clearOpeningContentOcclusion();
      sharedOpeningGeometry = null;
      document.documentElement.classList.remove("safari-v8-opening-clock");
      newTabOpening = false;
    }
    // TabClose can precede Firefox's native closing attribute.
    // Retire every painted descendant before clearing address ownership.
    event.target.classList.add("safari-v8-retiring");
    cancelContentHandoff();
    hideClose();
    hideReload();
    if (event.target === addressOwner) {
      hideCleanGlyph();
      setVisible(false);
    }
    // TabClose precedes the native closing flag on some Firefox versions.
    // Defer allocation to the event's completed native state, not a timer.
    scheduler.scheduleMicrotask(() => {
      updateNoScrollLayout();
      positionUrlbar();
      positionShelfGeometryProbe();
      // Follow the complete 300ms close transition, including its tail.
      followShelfGeometryAnimation(340);
    });
  }

  const layoutEvents = ["TabClose", "TabMove", "TabPinned", "TabUnpinned"];

  urlbar.classList.add("safari-v8-moving");
  ownEvent(tabs, "pointerdown", onTabPointerDown, true);
  patchMethod(
    nativeDragOwner,
    "startTabDrag",
    startTabDragWithLoneTabImage
  );
  patchMethod(
    nativeDragOwner,
    "_checkWithinPinnedContainerBounds",
    checkPinnedBoundsWithoutCompactCue
  );
  ownEvent(tabs, "dragstart", startDraggedControls, true);
  ownEvent(window, "dragover", forwardShelfDrag, true);
  ownEvent(window, "drop", forwardShelfDrag, true);
  ownEvent(window, "dragend", finishDraggedControls, true);
  ownEvent(window, "drop", finishDraggedControls, true);
  ownEvent(tabs, "click", onTabClick);
  ownEvent(tabs, "TabSelect", onTabSelect);
  ownEvent(tabs, "TabOpen", onTabOpen);
  ownEvent(tabs, "TabClose", onTabClose);
  layoutEvents.forEach(name => ownEvent(tabs, name, settle));
  ownEvent(document, "focusin", onFocusIn, true);
  ownEvent(document, "focusout", onFocusOut, true);
  ownEvent(document, "pointermove", onPointerMove, true);
  ownEvent(window, "keydown", onKeyDown, true);
  ownEvent(window, "resize", settle);
  ownEvent(closeButton, "pointerdown", blockClosePress, true);
  ownEvent(closeButton, "mousedown", blockClosePress, true);
  ownEvent(closeButton, "click", closeSelectedTab, true);
  ownEvent(reloadButton, "pointerdown", blockReloadPress, true);
  ownEvent(reloadButton, "mousedown", blockReloadPress, true);
  ownEvent(reloadButton, "click", reloadSelectedTab, true);

  const glyphObserver = ownObserver(new MutationObserver(updateGlyph));

  const urlbarView = document.querySelector(".urlbarView");
  if (urlbarView) {
    glyphObserver.observe(urlbarView, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["selected", "aria-selected", "src"]
    });
  }

  ownEvent(input, "input", onAddressInput, true);
  ownEvent(input, "select", updateGlyph, true);
  ownEvent(input, "focus", updateGlyph, true);

  ownEvent(tabs, "TabAttrModified", updateGlyph);
  ownEvent(tabs, "TabAttrModified", onSafariTabAttrModified);

  const resizeObserver = ownObserver(new ResizeObserver(render));
  resizeObserver.observe(toolbar);

  const cleanup = () => {
    if (lifecycle.disposed) return;

    /*
     * Invalidate asynchronous work before releasing resources. A callback
     * queued by this instance can never act on a replacement instance.
     */
    lifecycle.disposed = true;
    scheduler.invalidate();
    newTabGeometryToken += 1;
    shelfProbeAnimationToken += 1;
    newTabOpening = false;
    restoreTabCommandPending = false;

    clearIconLabelReveals();
    stopDraggedControls();
    clearOpeningContentOcclusion();
    sharedOpeningGeometry = null;
    document.documentElement.classList.remove("safari-v8-opening-clock");
    for (const [element, value] of noScrollFlexAttributes) {
      if (!element.hasAttribute("flex")) element.setAttribute("flex", value);
    }
    noScrollFlexAttributes.clear();
    cancelContentHandoff();
    document.documentElement.classList.remove(
      "safari-v8-no-scroll", "safari-v8-dense-tabs",
      "safari-v8-navigation-layout-follow"
    );
    tabs.style.removeProperty("--safari-v8-row-width");
    tabs.style.removeProperty("--safari-v8-edit-width");
    tabs.style.removeProperty("--safari-v8-row-offset");
    for (const tab of gBrowser.tabs) {
      tab.classList.remove("safari-v8-icon-only");
      tab.style.removeProperty("--safari-v8-pill-start");
      tab.style.removeProperty("--safari-v8-pill-end");
      tab.style.removeProperty("--safari-v8-tab-width");
      tab.style.removeProperty("--safari-v8-tab-grow");
      tab.style.removeProperty("--safari-v8-content-center");
    }
    document.documentElement.classList.remove("safari-v8-opening-reserve");
    hideCleanGlyph();
    retireAddressPresentation();
    clearAddressState();
    tabs.querySelectorAll(".safari-v8-compact-tab").forEach(tab => {
      tab.classList.remove("safari-v8-compact-tab");
    });
    document.documentElement.classList.remove("safari-v8-address-active");
    urlbar.classList.remove(
      "safari-v8-moving", "safari-v8-visible",
      "safari-v8-exact-close-hover", "safari-v8-newtab-enter"
    );
    [
      "--safari-v8-left",
      "--safari-v8-top",
      "--safari-v8-width",
      "--safari-v8-height"
    ].forEach(property => urlbar.style.removeProperty(property));
    urlbar.style.removeProperty("--safari-v8-source-scheme");
    urlbar.style.removeProperty("--safari-v8-pill-start");
    urlbar.style.removeProperty("--safari-v8-pill-end");
    glyph.style.removeProperty("list-style-image");
    glyph.classList.remove("safari-v8-search-glyph");
    glyphSlot.classList.remove("safari-v8-close-mask");

    while (lifecycle.disposers.length) {
      try {
        lifecycle.disposers.pop()();
      } catch (error) {
        console.error("Safari Compact: resource cleanup failed", error);
      }
    }
    if (window.__safariCompactCleanup === cleanup) {
      delete window.__safariCompactCleanup;
    }
  };
  window.__safariCompactCleanup = cleanup;

  document.documentElement.classList.remove(
    "safari-v8-opening-reserve"
  );
  /*
   * The initial tab already exists when this script takes over its layout.
   * Apply the first no-scroll allocation with transitions suppressed, flush
   * that final geometry, then restore normal transitions for later TabOpen.
   */
  document.documentElement.classList.add(
    "safari-v8-no-scroll", "safari-v8-initial-layout"
  );
  updateNoScrollLayout();
  updateAllSafariDisplayLabels();
  void tabs.getBoundingClientRect();
  document.documentElement.classList.remove("safari-v8-initial-layout");
  settle();
})();
