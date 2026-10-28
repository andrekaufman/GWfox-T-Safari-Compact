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

  const reloadButton = document.createElement("button");
  reloadButton.id = "safari-v8-tab-reload";
  reloadButton.type = "button";
  reloadButton.tabIndex = -1;
  reloadButton.title = "Ladda om sida";
  reloadButton.setAttribute("aria-label", "Ladda om sida");
  document.documentElement.appendChild(reloadButton);

  const shelfProbe = document.createElement("div");
  shelfProbe.id = "safari-v8-shelf-geometry-probe";
  shelfProbe.setAttribute("aria-hidden", "true");

  /*
   * Keep the decorative shelf in the same stacking context as the real
   * tabs. Position: fixed still uses viewport coordinates, while DOM
   * placement guarantees that selected tab surfaces paint above it.
   */
  tabs.prepend(shelfProbe);

  /*
   * External compositing surface. This is the only tested paint position
   * that makes the editable address pill visually match the active tab.
   */
  const addressSurface = document.createElement("div");
  addressSurface.id = "safari-v8-address-surface";
  addressSurface.setAttribute("aria-hidden", "true");
  document.documentElement.appendChild(addressSurface);

  const inputContainer = urlbar.querySelector(".urlbar-input-container");
  const glyphSlot = document.querySelector("#trust-icon-container");
  const glyph = document.querySelector("#trust-icon");

  /*
   * The external Soft Light surface corrects the address material, but it
   * also changes favicon colours. Render an untouched copy of the resolved
   * glyph above the compositing surface.
   */
  const cleanGlyph = document.createElement("div");
  cleanGlyph.id = "safari-v8-clean-glyph";
  cleanGlyph.setAttribute("aria-hidden", "true");
  document.documentElement.appendChild(cleanGlyph);

  if (!inputContainer || !glyphSlot || !glyph) {
    closeButton.remove();
    return;
  }

  let visible = false;
  let closeHover = false;
  let reloadHover = false;
  let glyphFrame = 0;
  let glyphObserver = null;
  let newTabFocusTimer = 0;
  let newTabOpening = false;
  let frame = 0;
  let settleTimer = 0;
  let resizeObserver = null;
  let shelfProbeAnimationFrame = 0;
  let shelfProbeAnimationToken = 0;
  const shifted = new Set();

  const preferredExpansion = 96;
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

  function updateSafariDisplayLabel(tab) {
    if (!tab || tab.hidden || tab.closing) return;
    const label = tab.querySelector(".tab-label");
    if (!label) return;
    label.setAttribute("data-safari-display-label", safariDisplayLabel(tab));
  }

  function updateAllSafariDisplayLabels() {
    for (const tab of gBrowser.tabs) updateSafariDisplayLabel(tab);
  }

  function onSafariTabAttrModified(event) {
    updateSafariDisplayLabel(event.target);
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

  let tabCloseTarget = null;
  let controlHideTimer = 0;
  let selectedTabClickCandidate = null;

  /*
   * Firefox shifts the complete tab strip by about 52 px when the selected
   * tab changes between having and not having navigation history.
   * Capture the pre-change geometry and visually bridge that reflow.
   */
  let navigationShiftSnapshot = null;
  let navigationShiftAnimations = [];
  let navigationShiftGeometryFrame = 0;
  let navigationShiftInProgress = false;

  function navigationShiftTargets() {
    return [
      ...Array.from(gBrowser.tabs).filter(
        tab =>
          !tab.hidden &&
          !tab.closing
      ),
      plusButton(),
      shelfProbe,
      closeButton,
      reloadButton,
      addressSurface,
      cleanGlyph
    ].filter(element => {
      if (!element || !element.isConnected) return false;

      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    });
  }

  function captureNavigationShiftSnapshot() {
    const tab = selectedTab();
    const rects = new Map();

    for (const element of navigationShiftTargets()) {
      const rect = element.getBoundingClientRect();

      rects.set(element, {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      });
    }

    navigationShiftSnapshot = {
      tabsLeft:
        tabs.getBoundingClientRect().left,

      canGoBack:
        Boolean(
          tab?.linkedBrowser?.canGoBack
        ),

      rects
    };
  }

  function cancelNavigationShiftAnimations() {
    cancelAnimationFrame(
      navigationShiftGeometryFrame
    );
    navigationShiftGeometryFrame = 0;

    const animations = navigationShiftAnimations;
    navigationShiftAnimations = [];

    for (const animation of animations) {
      try {
        animation.cancel();
      } catch {}
    }
  }

  function positionFinalNavigationGeometry() {
    positionUrlbar();
    applyPush();
    positionAddressSurface();
    positionShelfGeometryProbe();

    if (visible) {
      updateCleanGlyph();
    }

    if (closeHover) {
      positionCloseButton();
    }

    if (reloadHover) {
      positionReloadButton();
    }
  }

  function animateNavigationShiftIfNeeded() {
    const snapshot = navigationShiftSnapshot;
    navigationShiftSnapshot = null;

    if (!snapshot) return;

    const tab = selectedTab();
    if (!tab) return;

    const newTabsLeft =
      tabs.getBoundingClientRect().left;

    const newCanGoBack =
      Boolean(tab.linkedBrowser?.canGoBack);

    const stripDelta =
      snapshot.tabsLeft - newTabsLeft;

    const navigationGeometryChanged =
      snapshot.canGoBack !== newCanGoBack &&
      Math.abs(stripDelta) >= 24 &&
      Math.abs(stripDelta) <= 80;

    if (!navigationGeometryChanged) return;

    cancelNavigationShiftAnimations();

    shelfProbeAnimationToken += 1;
    cancelAnimationFrame(shelfProbeAnimationFrame);
    shelfProbeAnimationFrame = 0;

    /*
     * First establish the exact final logical geometry.
     */
    positionFinalNavigationGeometry();

    /*
     * While navigation FLIP runs, WAAPI and the shelf rAF interpolator
     * exclusively own visual geometry. Ordinary CSS transitions would
     * otherwise restart on every frame and make fixed layers lag behind.
     */
    document.documentElement.classList.add(
      "safari-v8-navigation-shift"
    );

    const oldShelfRect =
      snapshot.rects.get(shelfProbe);

    const finalShelfBox =
      shelfProbe.getBoundingClientRect();

    const finalShelfRect = {
      left: finalShelfBox.left,
      top: finalShelfBox.top,
      width: finalShelfBox.width,
      height: finalShelfBox.height
    };

    navigationShiftInProgress = true;

    const timing = {
      duration: 180,
      easing:
        "cubic-bezier(.2, .8, .2, 1)",
      fill: "none"
    };

    /*
     * A constant-opacity animation acts as the shared timing clock.
     * Reading computed progress gives the exact same easing curve used
     * by tabs, plusknapp and fixed controls.
     */
    const clock = shelfProbe.animate(
      [
        { opacity: 1 },
        { opacity: 1 }
      ],
      timing
    );

    const animations = [clock];

    /*
     * Interpolate real shelf variables rather than scaling the painted
     * shelf. Border radius, border and material therefore remain stable.
     */
    if (oldShelfRect) {
      const lerp = (from, to, progress) =>
        from + (to - from) * progress;

      const applyShelfProgress = progress => {
        /*
         * Navigation history changes only the horizontal reservation.
         * Keep vertical geometry fixed throughout the transition so the
         * shelf cannot grow or contract by subpixels between frames.
         */
        shelfProbe.style.setProperty(
          "--probe-left",
          `${lerp(
            oldShelfRect.left,
            finalShelfRect.left,
            progress
          )}px`
        );

        shelfProbe.style.setProperty(
          "--probe-top",
          `${finalShelfRect.top}px`
        );

        shelfProbe.style.setProperty(
          "--probe-width",
          `${Math.max(
            1,
            lerp(
              oldShelfRect.width,
              finalShelfRect.width,
              progress
            )
          )}px`
        );

        shelfProbe.style.setProperty(
          "--probe-height",
          `${Math.max(
            1,
            finalShelfRect.height
          )}px`
        );
      };

      applyShelfProgress(0);

      const tickShelf = () => {
        if (!navigationShiftInProgress) return;

        /*
         * Tab transforms are sampled directly by the compositor, while
         * shelf variables are written by this requestAnimationFrame
         * callback. Sample the shared timeline approximately one display
         * frame ahead to compensate for that scheduling difference.
         */
        const duration = 180;
        const frameLead = 16;

        const currentTime =
          typeof clock.currentTime === "number"
            ? clock.currentTime
            : 0;

        const rawProgress =
          Math.max(
            0,
            Math.min(
              1,
              (currentTime + frameLead) / duration
            )
          );

        /*
         * Evaluate the same cubic-bezier(.2, .8, .2, 1) curve as the
         * compositor animation. First invert x numerically, then read y.
         */
        const cubic = (a, b, c, d, t) => {
          const inverse = 1 - t;

          return (
            inverse * inverse * inverse * a +
            3 * inverse * inverse * t * b +
            3 * inverse * t * t * c +
            t * t * t * d
          );
        };

        let low = 0;
        let high = 1;

        for (
          let iteration = 0;
          iteration < 10;
          iteration++
        ) {
          const middle = (low + high) / 2;

          const x = cubic(
            0,
            .2,
            .2,
            1,
            middle
          );

          if (x < rawProgress) {
            low = middle;
          } else {
            high = middle;
          }
        }

        const curveTime = (low + high) / 2;

        const boundedProgress = cubic(
          0,
          .8,
          1,
          1,
          curveTime
        );

        applyShelfProgress(boundedProgress);

        if (boundedProgress < 1) {
          navigationShiftGeometryFrame =
            requestAnimationFrame(tickShelf);
        } else {
          navigationShiftGeometryFrame = 0;
        }
      };

      navigationShiftGeometryFrame =
        requestAnimationFrame(tickShelf);
    }

    const currentTargets =
      navigationShiftTargets();

    const targetSet = new Set([
      ...snapshot.rects.keys(),
      ...currentTargets
    ]);

    for (const element of targetSet) {
      if (
        !element?.isConnected ||
        element === shelfProbe
      ) {
        continue;
      }

      const oldRect =
        snapshot.rects.get(element);

      if (!oldRect) continue;

      const newRect =
        element.getBoundingClientRect();

      if (
        newRect.width <= 0 ||
        newRect.height <= 0
      ) {
        continue;
      }

      const deltaX =
        oldRect.left - newRect.left;

      const deltaY =
        oldRect.top - newRect.top;

      if (
        Math.abs(deltaX) < 0.5 &&
        Math.abs(deltaY) < 0.5
      ) {
        continue;
      }

      const isRealTab =
        element.classList?.contains(
          "tabbrowser-tab"
        );

      const isPlusButton =
        element === plusButton();

      let animation;

      if (isRealTab || isPlusButton) {
        animation = element.animate(
          [
            {
              transform:
                `translate(${deltaX}px, ${deltaY}px)`
            },
            {
              transform:
                "translate(0px, 0px)"
            }
          ],
          timing
        );
      } else {
        /*
         * Fixed visual layers use translate so their !important left/top
         * declarations and reload's own scale/rotation remain intact.
         */
        animation = element.animate(
          [
            {
              translate:
                `${deltaX}px ${deltaY}px`
            },
            {
              translate:
                "0px 0px"
            }
          ],
          timing
        );
      }

      animations.push(animation);
    }

    navigationShiftAnimations = animations;

    Promise.all(
      animations.map(animation =>
        animation.finished.catch(() => null)
      )
    ).then(() => {
      if (
        navigationShiftAnimations !== animations
      ) {
        return;
      }

      cancelAnimationFrame(
        navigationShiftGeometryFrame
      );
      navigationShiftGeometryFrame = 0;

      navigationShiftAnimations = [];
      navigationShiftInProgress = false;

      document.documentElement.classList.remove(
        "safari-v8-navigation-shift"
      );

      positionFinalNavigationGeometry();
      settle();
    });
  }

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
      queueMicrotask(updateCleanGlyph);
    }
  }

  function hideReload() {
    reloadHover = false;
    reloadButton.classList.remove("visible");
  }

  function setVisible(state) {
    visible = state;
    document.documentElement.classList.toggle("safari-v8-address-active", state);
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

    /*
     * Firefox animates a new tab from about 97 px to the normal 225 px.
     * Safari Compact must position the address overlay from the final width
     * immediately, otherwise the shelf visibly retracts and expands again.
     */
    const stableTabWidth =
      newTabOpening && isBlankNewTab(tab)
        ? Math.max(rect.width, 225)
        : rect.width;

    urlbar.style.setProperty("--safari-v8-left", `${rect.left + xGap}px`);
    urlbar.style.setProperty("--safari-v8-top", `${rect.top + yGap}px`);
    urlbar.style.setProperty("--safari-v8-width", `${Math.max(1, stableTabWidth - xGap * 2)}px`);
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
    if (!visible) {
      clearPush();
      return;
    }

    const active = selectedTab();
    const plus = plusButton();

    if (!active) {
      clearPush();
      return;
    }

    const expansion = safeExpansion(plus);

    if (expansion < 8) {
      clearPush();
      return;
    }

    urlbar.style.setProperty(
      "--safari-v8-expand",
      `${expansion}px`
    );

    /*
     * Reconcile the desired push targets instead of clearing and rebuilding
     * them on every render. Removing and immediately restoring the class
     * restarted the translate transition during the delayed settle render,
     * producing a 96 px -> 0 px -> 96 px reversal.
     */
    const desired = new Set();
    let afterActive = false;

    for (const tab of gBrowser.tabs) {
      if (tab === active) {
        afterActive = true;
        continue;
      }

      if (
        afterActive &&
        !tab.hidden &&
        !tab.closing
      ) {
        desired.add(tab);
      }
    }

    if (plus) {
      desired.add(plus);
    }

    for (const element of [...shifted]) {
      if (desired.has(element)) continue;

      element.classList.remove("safari-v8-pushed");
      element.style.removeProperty("--safari-v8-push");
      shifted.delete(element);
    }

    for (const element of desired) {
      element.style.setProperty(
        "--safari-v8-push",
        `${expansion}px`
      );

      if (!shifted.has(element)) {
        element.classList.add("safari-v8-pushed");
        shifted.add(element);
      }
    }
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
    glyph.style.setProperty(
      "list-style-image",
      `url("${source || searchGlyph}")`,
      "important"
    );
  }

  function resolveGlyph() {
    if (isBlankNewTab() && input.value.length === 0) return searchGlyph;

    const suggestion = selectedSuggestionGlyph();
    if (suggestion) return suggestion;

    const pageState = inputContainer.getAttribute("pageproxystate") || "";
    const wholeValueSelected =
      input.value.length > 0 &&
      input.selectionStart === 0 &&
      input.selectionEnd === input.value.length;

    if (pageState === "valid" || wholeValueSelected) {
      return selectedTabGlyph() || searchGlyph;
    }

    return searchGlyph;
  }

  function hideCleanGlyph() {
    cleanGlyph.classList.remove("visible");
    glyph.style.removeProperty("opacity");
  }

  function updateCleanGlyph() {
    const closeActive =
      urlbar.classList.contains("safari-v8-exact-close-hover");

    if (
      !visible ||
      closeActive ||
      !urlbar.classList.contains("safari-v8-visible")
    ) {
      hideCleanGlyph();
      return;
    }

    const rect = glyph.getBoundingClientRect();
    const style = getComputedStyle(glyph);

    const source =
      style.listStyleImage !== "none"
        ? style.listStyleImage
        : style.backgroundImage;

    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      !source ||
      source === "none"
    ) {
      hideCleanGlyph();
      return;
    }

    cleanGlyph.style.setProperty(
      "--clean-glyph-left",
      `${rect.left}px`
    );
    cleanGlyph.style.setProperty(
      "--clean-glyph-top",
      `${rect.top}px`
    );
    cleanGlyph.style.setProperty(
      "--clean-glyph-width",
      `${rect.width}px`
    );
    cleanGlyph.style.setProperty(
      "--clean-glyph-height",
      `${rect.height}px`
    );
    cleanGlyph.style.setProperty(
      "--clean-glyph-image",
      source
    );

    glyph.style.setProperty(
      "opacity",
      "0",
      "important"
    );

    cleanGlyph.classList.add("visible");
  }

  function updateGlyph() {
    cancelAnimationFrame(glyphFrame);
    if (!visible || !urlbar.classList.contains("safari-v8-visible")) return;

    applyGlyph(resolveGlyph());

    queueMicrotask(() => {
      if (!visible) return;
      applyGlyph(resolveGlyph());
      updateCleanGlyph();
    });

    glyphFrame = requestAnimationFrame(() => {
      if (!visible) return;
      applyGlyph(resolveGlyph());
      updateCleanGlyph();
    });
  }

  function positionShelfGeometryProbe() {
    const normalTabs = [...tabs.querySelectorAll(
      ".tabbrowser-tab:not([pinned], [hidden])"
    )].filter(tab => {
      const rect = tab.getBoundingClientRect();
      return !tab.closing && rect.width > 0 && rect.height > 0;
    });

    if (!normalTabs.length) {
      shelfProbe.classList.remove("visible");
      return;
    }

    const firstBackground = normalTabs[0]
      .querySelector(".tab-background")?.getBoundingClientRect();
    const lastBackground = normalTabs.at(-1)
      .querySelector(".tab-background")?.getBoundingClientRect();
    const plus = plusButton();
    const plusRect = plus?.getBoundingClientRect();
    const urlRect = visible ? urlbar.getBoundingClientRect() : null;

    if (!firstBackground || !lastBackground) {
      shelfProbe.classList.remove("visible");
      return;
    }

    /*
     * Reveal the same approximately 3 px of grey shelf at the leading edge
     * as above and below the first pill. Using firstBackground.left directly
     * made the shelf begin at the already scaled pill edge, leaving zero
     * visible leading inset.
     */
    const opticalStartPadding = 3;

    const left = Math.min(
      firstBackground.left - opticalStartPadding,
      urlRect?.left ?? Infinity
    );

    const opticalEndPadding = visible ? 0 : 3;
    const desiredRight = Math.max(
      lastBackground.right + opticalEndPadding,
      urlRect?.right ?? -Infinity
    );
    const rightLimit = plusRect && plusRect.width > 0
      ? plusRect.left - 8
      : desiredRight;
    const right = Math.min(desiredRight, rightLimit);
    /*
     * Background rectangles are visually scaled for selected and hovered
     * pills. Deriving shelf height from those painted rectangles made the
     * shelf pulse vertically when selection moved between tabs.
     *
     * The real tab rectangle is stable at 44 px. Firefox's tab background
     * occupies the central 36 px, with a 4 px inset above and below.
     */
    const firstTabRect =
      normalTabs[0].getBoundingClientRect();

    const stableTop =
      firstTabRect.top + 4;

    const stableBottom =
      firstTabRect.bottom - 4;

    const top = visible
      ? Math.min(
          stableTop,
          urlRect?.top ?? Infinity
        )
      : stableTop;

    const bottom = visible
      ? Math.max(
          stableBottom,
          urlRect?.bottom ?? -Infinity
        )
      : stableBottom;

    shelfProbe.style.setProperty("--probe-left", `${left}px`);
    shelfProbe.style.setProperty("--probe-top", `${top}px`);
    shelfProbe.style.setProperty("--probe-width", `${Math.max(1, right - left)}px`);
    shelfProbe.style.setProperty("--probe-height", `${Math.max(1, bottom - top)}px`);
    shelfProbe.classList.toggle("address-mode", visible);
    shelfProbe.classList.add("visible");
  }

  function followShelfGeometryAnimation(duration = 210) {
    const token = ++shelfProbeAnimationToken;
    const started = performance.now();
    cancelAnimationFrame(shelfProbeAnimationFrame);

    const tick = now => {
      if (token !== shelfProbeAnimationToken) return;
      positionShelfGeometryProbe();

      if (now - started < duration) {
        shelfProbeAnimationFrame = requestAnimationFrame(tick);
      } else {
        shelfProbeAnimationFrame = 0;
        positionShelfGeometryProbe();
      }
    };

    shelfProbeAnimationFrame = requestAnimationFrame(tick);
  }

  function positionAddressSurface() {
    if (!visible) {
      addressSurface.classList.remove("visible");
      return;
    }

    const rect = urlbar.getBoundingClientRect();

    if (rect.width <= 0 || rect.height <= 0) {
      addressSurface.classList.remove("visible");
      return;
    }

    addressSurface.style.setProperty(
      "--surface-left",
      `${rect.left + 4}px`
    );
    addressSurface.style.setProperty(
      "--surface-top",
      `${rect.top + 3}px`
    );
    addressSurface.style.setProperty(
      "--surface-width",
      `${Math.max(1, rect.width - 8)}px`
    );
    addressSurface.style.setProperty(
      "--surface-height",
      `${Math.max(1, rect.height - 6)}px`
    );

    addressSurface.classList.add("visible");
  }

  function render() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      positionUrlbar();
      applyPush();
      updateGlyph();

      /*
       * Fixed visual layers receive their own exact FLIP animation.
       * Do not rewrite their viewport coordinates until that animation
       * has completed.
       */
      if (!navigationShiftInProgress) {
        positionAddressSurface();
        positionShelfGeometryProbe();
        followShelfGeometryAnimation();
        updateCleanGlyph();

        if (closeHover) {
          positionCloseButton();
        }

        if (reloadHover) {
          positionReloadButton();
        }
      }
    });
  }

  function settle() {
    clearTimeout(settleTimer);
    render();
    settleTimer = setTimeout(render, 120);
  }

  function revealSelectedAddressFromStart() {
    input.scrollLeft = 0;

    requestAnimationFrame(() => {
      input.scrollLeft = 0;
      setTimeout(() => {
        input.scrollLeft = 0;
      }, 0);
    });
  }

  function openUrlbar() {
    const tab = selectedTab();
    if (!tab) return;

    if (visible) {
      gURLBar.focus();
      gURLBar.select();
      revealSelectedAddressFromStart();
      updateGlyph();
      return;
    }

    // Prepare every visual state before focus can trigger Firefox painting.
    tab.classList.add("safari-v8-address");
    positionUrlbar();
    setVisible(true);
    applyPush();
    positionAddressSurface();

    requestAnimationFrame(() => {
      gURLBar.focus();
      gURLBar.select();
      revealSelectedAddressFromStart();
      updateGlyph();
      positionUrlbar();
    });
  }

  function closeUrlbar() {
    const tab = selectedTab();
    const wasVisible = visible;
    hideCleanGlyph();
    setVisible(false);
    clearPush();
    positionAddressSurface();
    positionShelfGeometryProbe();
    followShelfGeometryAnimation();

    if (wasVisible && tab && !newTabOpening) {
      tab.classList.remove("safari-v8-content-return");
      void tab.getBoundingClientRect();
      tab.classList.add("safari-v8-content-return");
      setTimeout(() => tab.classList.remove("safari-v8-content-return"), 140);
    }
  }

  function controlTargetRect() {
    if (tabCloseTarget && tabCloseTarget !== selectedTab()) {
      return tabCloseTarget
        .querySelector(".tab-background")
        ?.getBoundingClientRect() || null;
    }

    if (visible) return urlbar.getBoundingClientRect();

    return tabCloseTarget
      ?.querySelector(".tab-background")
      ?.getBoundingClientRect() || null;
  }

  function positionCloseButton() {
    const rect = controlTargetRect();
    if (!rect) return;

    const size = 18;
    const centerX = rect.left + (visible ? 20 : 23);
    const centerY = rect.top + rect.height / 2;

    closeButton.style.setProperty("--close-left", `${centerX - size / 2}px`);
    closeButton.style.setProperty("--close-top", `${centerY - size / 2}px`);

    if (!visible && tabCloseTarget) {
      const iconRect = tabCloseTarget
        .querySelector(".tab-icon-stack")
        ?.getBoundingClientRect();
      const closeLeft = centerX - size / 2;
      const closeRight = centerX + size / 2;
      const overlapsIcon = Boolean(
        iconRect &&
        closeRight > iconRect.left &&
        closeLeft < iconRect.right
      );
      tabCloseTarget.classList.toggle(
        "safari-v8-close-over-icon",
        overlapsIcon
      );
    }
  }

  function showClose(tab = null) {
    if (!visible) tabCloseTarget = tab;
    closeHover = true;
    positionCloseButton();
    urlbar.classList.toggle("safari-v8-exact-close-hover", visible);

    if (visible) {
      glyphSlot.classList.add("safari-v8-close-mask");

      /*
       * The clean glyph is painted above the compositing surface and would
       * otherwise cover the fixed close control. Hide it synchronously when
       * close hover begins.
       */
      hideCleanGlyph();
    }

    closeButton.classList.add("visible");
  }

  function controlTargetTab() {
    return tabCloseTarget || selectedTab();
  }

  function reloadTargetRect() {
    if (tabCloseTarget && tabCloseTarget !== selectedTab()) {
      return tabCloseTarget
        .querySelector(".tab-background")
        ?.getBoundingClientRect() || null;
    }

    if (visible) return urlbar.getBoundingClientRect();

    return tabCloseTarget
      ?.querySelector(".tab-background")
      ?.getBoundingClientRect() || null;
  }

  function canReloadSelectedTab() {
    const tab = controlTargetTab();
    const spec = tab?.linkedBrowser?.currentURI?.spec || "";
    return Boolean(tab) &&
      spec !== "about:newtab" &&
      spec !== "about:home" &&
      spec !== "about:blank";
  }

  function positionReloadButton() {
    const rect = reloadTargetRect();
    if (!rect) return;

    const size = 18;
    const centerX = rect.right - 23;
    const centerY = rect.top + rect.height / 2;
    reloadButton.style.setProperty(
      "--reload-left",
      `${centerX - size / 2}px`
    );
    reloadButton.style.setProperty(
      "--reload-top",
      `${centerY - size / 2}px`
    );
  }

  function showReload() {
    if (!canReloadSelectedTab()) {
      hideReload();
      return;
    }

    reloadHover = true;
    positionReloadButton();
    reloadButton.classList.add("visible");
  }

  function onPointerMove(event) {
    /*
     * Close and reload belong to the geometry captured at the beginning
     * of the navigation transaction. Do not retarget or reposition them
     * while their shared FLIP animation is running.
     */
    if (navigationShiftInProgress) return;
    const onClose =
      event.target === closeButton || closeButton.contains(event.target);
    const onReload =
      event.target === reloadButton || reloadButton.contains(event.target);

    const hoveredTab =
      event.target.closest?.(".tabbrowser-tab:not([pinned])");

    const validTab = Boolean(
      hoveredTab && !hoveredTab.hidden && !hoveredTab.closing
    );

    clearTimeout(controlHideTimer);

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

        if (leading) {
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
    captureNavigationShiftSnapshot();

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
    updateSafariDisplayLabel(selectedTab());

    /*
     * TabSelect fires after Firefox has committed the new navigation-button
     * geometry. Measure synchronously before the browser paints the reflow.
     */
    animateNavigationShiftIfNeeded();

    queueMicrotask(() => {
      if (!newTabOpening) closeUrlbar();
      settle();
    });
  }

  function onFocusIn(event) {
    if (event.target === input || urlbar.contains(event.target)) {
      setVisible(true);
      render();
    }
  }

  function onFocusOut() {
    requestAnimationFrame(() => {
      if (newTabOpening) return;

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

  function playNewTabEntrance() {
    urlbar.classList.remove("safari-v8-newtab-enter");
    void urlbar.getBoundingClientRect();
    urlbar.classList.add("safari-v8-newtab-enter");
  }

  function onNewTabAnimationEnd(event) {
    if (event.animationName === "safari-v8-newtab-content-in") {
      urlbar.classList.remove("safari-v8-newtab-enter");
    }
  }

  function onTabOpen(event) {
    clearTimeout(newTabFocusTimer);
    const openedTab = event.target;

    /*
     * If TabSelect already consumed the snapshot this is a no-op.
     * Otherwise bridge the new-tab navigation reflow here.
     */
    queueMicrotask(
      animateNavigationShiftIfNeeded
    );
    updateSafariDisplayLabel(openedTab);
    newTabOpening = true;

    /*
     * TabOpen and TabSelect complete in the same event turn. Queue the
     * complete visual transaction as a microtask so the ordinary
     * "New Tab" face is replaced before the browser paints a frame.
     */
    queueMicrotask(() => {
      if (
        openedTab !== gBrowser.selectedTab ||
        openedTab.closing ||
        openedTab.hidden
      ) {
        newTabOpening = false;
        return;
      }

      openUrlbar();
      updateGlyph();

      if (isBlankNewTab(openedTab)) {
        applyGlyph(searchGlyph);
        playNewTabEntrance();
      }
    });

    /*
     * Firefox performs a late native focus transfer. Re-assert only
     * focus and selection afterwards; the visual state is already live.
     */
    newTabFocusTimer = setTimeout(() => {
      if (
        openedTab === gBrowser.selectedTab &&
        !openedTab.closing &&
        !openedTab.hidden
      ) {
        gURLBar.focus();
        gURLBar.select();
        revealSelectedAddressFromStart();
        updateGlyph();
      }

      newTabOpening = false;
    }, 80);
  }

  const layoutEvents = ["TabClose", "TabMove", "TabPinned", "TabUnpinned"];

  urlbar.classList.add("safari-v8-moving");
  tabs.addEventListener("pointerdown", onTabPointerDown, true);
  tabs.addEventListener("click", onTabClick);
  tabs.addEventListener("TabSelect", onTabSelect);
  tabs.addEventListener("TabOpen", onTabOpen);
  urlbar.addEventListener("animationend", onNewTabAnimationEnd);
  layoutEvents.forEach(name => tabs.addEventListener(name, settle));
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", settle);
  closeButton.addEventListener("pointerdown", blockClosePress, true);
  closeButton.addEventListener("mousedown", blockClosePress, true);
  closeButton.addEventListener("click", closeSelectedTab, true);
  reloadButton.addEventListener("pointerdown", blockReloadPress, true);
  reloadButton.addEventListener("mousedown", blockReloadPress, true);
  reloadButton.addEventListener("click", reloadSelectedTab, true);

  glyphObserver = new MutationObserver(updateGlyph);

  const urlbarView = document.querySelector(".urlbarView");
  if (urlbarView) {
    glyphObserver.observe(urlbarView, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["selected", "aria-selected", "src"]
    });
  }

  input.addEventListener("input", updateGlyph, true);
  input.addEventListener("select", updateGlyph, true);
  input.addEventListener("focus", updateGlyph, true);

  tabs.addEventListener("TabAttrModified", updateGlyph);
  tabs.addEventListener("TabAttrModified", onSafariTabAttrModified);

  resizeObserver = new ResizeObserver(render);
  resizeObserver.observe(toolbar);

  window.__safariCompactCleanup = () => {
    cancelAnimationFrame(frame);
    cancelAnimationFrame(glyphFrame);
    clearTimeout(settleTimer);

    cancelNavigationShiftAnimations();
    navigationShiftSnapshot = null;
    navigationShiftGeometryFrame = 0;
    navigationShiftInProgress = false;

    document.documentElement.classList.remove(
      "safari-v8-navigation-shift"
    );
    clearTimeout(newTabFocusTimer);
    clearTimeout(controlHideTimer);
    shelfProbeAnimationToken += 1;
    cancelAnimationFrame(shelfProbeAnimationFrame);
    newTabOpening = false;
    resizeObserver?.disconnect();
    glyphObserver?.disconnect();
    hideCleanGlyph();
    cleanGlyph.remove();
    addressSurface.remove();
    tabs.removeEventListener(
      "pointerdown",
      onTabPointerDown,
      true
    );
    tabs.removeEventListener("click", onTabClick);
    tabs.removeEventListener("TabSelect", onTabSelect);
    tabs.removeEventListener("TabOpen", onTabOpen);
    urlbar.removeEventListener("animationend", onNewTabAnimationEnd);
    tabs.removeEventListener("TabAttrModified", updateGlyph);
    tabs.removeEventListener("TabAttrModified", onSafariTabAttrModified);
    input.removeEventListener("input", updateGlyph, true);
    input.removeEventListener("select", updateGlyph, true);
    input.removeEventListener("focus", updateGlyph, true);

    layoutEvents.forEach(name => tabs.removeEventListener(name, settle));
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", settle);
    closeButton.removeEventListener("pointerdown", blockClosePress, true);
    closeButton.removeEventListener("mousedown", blockClosePress, true);
    closeButton.removeEventListener("click", closeSelectedTab, true);
    reloadButton.removeEventListener("pointerdown", blockReloadPress, true);
    reloadButton.removeEventListener("mousedown", blockReloadPress, true);
    reloadButton.removeEventListener("click", reloadSelectedTab, true);
    closeUrlbar();
    clearAddressState();
    document.documentElement.classList.remove("safari-v8-address-active");
    urlbar.classList.remove(
      "safari-v8-moving", "safari-v8-visible",
      "safari-v8-exact-close-hover", "safari-v8-newtab-enter"
    );
    ["--safari-v8-left", "--safari-v8-top", "--safari-v8-width", "--safari-v8-height", "--safari-v8-expand"]
      .forEach(property => urlbar.style.removeProperty(property));
    glyph.style.removeProperty("list-style-image");
    glyphSlot.classList.remove("safari-v8-close-mask");
    closeButton.remove();
    reloadButton.remove();
    shelfProbe.remove();
    delete window.__safariCompactCleanup;
  };

  updateAllSafariDisplayLabels();
  settle();
})();
