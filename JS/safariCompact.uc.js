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
   * Keep the shelf below both address and native tab surfaces.
   * TabsToolbar paints above nav-bar; placing the shelf inside TabsToolbar
   * also tinted the address field underneath that toolbar.
   * Fixed positioning retains the existing viewport geometry.
   */
  const shelfPaintHost = document.querySelector("#nav-bar");
  if (!shelfPaintHost) {
    closeButton.remove();
    reloadButton.remove();
    return;
  }
  shelfPaintHost.prepend(shelfProbe);

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
  let newTabGeometryFrame = 0;
  let newTabGeometryToken = 0;
  let addressOwner = null;
  let pendingGlyphHandoffRect = null;
  let glyphHandoffAnimation = null;
  let plusPlacementAnimation = null;
  let frame = 0;
  let settleTimer = 0;
  let resizeObserver = null;
  let shelfProbeAnimationFrame = 0;
  let shelfProbeAnimationToken = 0;
  let selectedTabScrollFrame = 0;
  let controlsSuppressedByScroll = false;
  let scrollControlTimer = 0;
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

  function compactSafariDisplayLabel(tab, fullLabel) {
    if (noScrollLayoutEnabled()) {
      tab.classList.remove("safari-v8-compact-tab");
      return fullLabel;
    }
    const compact =
      tabs.hasAttribute("overflow") ||
      tab.getBoundingClientRect().width < 168;

    tab.classList.toggle("safari-v8-compact-tab", compact);

    if (
      !compact ||
      tab === selectedTab() ||
      tab.classList.contains("safari-v8-address")
    ) {
      return fullLabel;
    }

    /*
     * Use discrete character-count levels rather than a continuously shrinking
     * CSS width. Tabs at the same compression level therefore show the same
     * number of characters, including the ellipsis.
     */
    const width = tab.getBoundingClientRect().width;
    const totalCharacters =
      width < 84 ? 7 :
      width < 108 ? 10 :
      width < 136 ? 14 :
      width < 168 ? 18 :
      Infinity;

    if (
      !Number.isFinite(totalCharacters) ||
      fullLabel.length <= totalCharacters
    ) {
      return fullLabel;
    }

    return `${fullLabel.slice(0, Math.max(1, totalCharacters - 3))}...`;
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
    updateSafariDisplayLabel(event.target);
  }

  function clearAddressState() {
    tabs.querySelectorAll(".safari-v8-address").forEach(tab => {
      tab.classList.remove("safari-v8-address");
    });
  }

  function clearShiftedElements() {
    for (const element of shifted) {
      element.classList.remove("safari-v8-pushed");
      element.style.removeProperty("--safari-v8-push");
    }
    shifted.clear();

    tabs.querySelectorAll(".safari-v8-source-expanded").forEach(tab => {
      tab.classList.remove("safari-v8-source-expanded");
      tab.style.removeProperty("--safari-v8-source-width");
      tab.style.removeProperty("--safari-v8-source-expand");
    });
  }

  function clearPush() {
    document.documentElement.classList.remove("safari-v8-shared-opening");
    clearShiftedElements();
    urlbar.style.removeProperty("--safari-v8-expand");
    urlbar.style.removeProperty("--safari-v8-left-shift");
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
      queueMicrotask(updateGlyph);
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

    if (state && tab) {
      addressOwner = tab;
      tab.classList.add("safari-v8-address");
    } else if (!state) {
      urlbar.classList.remove("safari-v8-newtab-enter");
      addressOwner = null;
      pendingGlyphHandoffRect = null;
      glyphHandoffAnimation?.cancel();
      glyphHandoffAnimation = null;
      hideClose();
    }
    if (noScrollLayoutEnabled()) updateNoScrollLayout();
  }

  let contentHandoffAnimations = [];

  function cancelContentHandoff() {
    for (const animation of contentHandoffAnimations) animation.cancel();
    contentHandoffAnimations = [];
  }

  function animateContentHandoff(element, deltaX) {
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
      { duration: 125, easing: "cubic-bezier(.2, .8, .2, 1)" }
    );
    contentHandoffAnimations.push(animation);
    animation.finished.catch(() => null).then(() => {
      contentHandoffAnimations =
        contentHandoffAnimations.filter(item => item !== animation);
    });
  }

  function noScrollLayoutEnabled() {
    return document.documentElement.classList.contains(
      "safari-v8-no-scroll"
    );
  }

  function positionNoScrollAddress() {
    updateNoScrollLayout();
    const tab = selectedTab();
    if (!tab) return;

    const rect = tab.getBoundingClientRect();
    // Native URL focus can select a different color scheme than the source tab.
    // Resolve the address material in the source content's scheme instead.
    const sourceContent = tab.querySelector(".tab-content") || tab;
    const sourceScheme = getComputedStyle(sourceContent).colorScheme;
    if (urlbar.style.getPropertyValue("--safari-v8-source-scheme") !== sourceScheme) {
      urlbar.style.setProperty("--safari-v8-source-scheme", sourceScheme);
    }
    // Address paint must use the same endpoint allocation as its source tab.
    // The source stack starts one native border pixel inside the tab.
    for (const name of ["--safari-v8-pill-start", "--safari-v8-pill-end"]) {
      const value = tab.style.getPropertyValue(name);
      if (urlbar.style.getPropertyValue(name) !== value) {
        urlbar.style.setProperty(name, value);
      }
    }
    urlbar.classList.remove(
      "safari-v8-clipped-start",
      "safari-v8-clipped-end",
      "safari-v8-outside-scrollport"
    );
    urlbar.style.setProperty("--safari-v8-expand", "0px");
    urlbar.style.setProperty("--safari-v8-left-shift", "0px");
    urlbar.style.setProperty("--safari-v8-left", `${rect.left}px`);
    urlbar.style.setProperty("--safari-v8-top", `${rect.top + 4}px`);
    urlbar.style.setProperty(
      "--safari-v8-width", `${Math.max(1, rect.width)}px`
    );
    urlbar.style.setProperty(
      "--safari-v8-height", `${Math.max(1, rect.height - 8)}px`
    );
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

  function updateNoScrollLayout() {
    const arrow = document.querySelector("#tabbrowser-arrowscrollbox");
    releaseNativeFlex(arrow);
    // Style inside the shadow root: hidden native arrows still occupied 28px
    // on each side when the external ::part rules did not take effect.
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
      arrow.shadowRoot.appendChild(noScrollShadowStyle);
    }
    const normalTabs = [...gBrowser.tabs].filter(
      tab => !tab.hidden && !tab.closing && !tab.pinned
    );
    if (!normalTabs.length) return;

    const container = tabs.getBoundingClientRect();
    const style = getComputedStyle(tabs);
    const padding =
      (Number.parseFloat(style.paddingLeft) || 0) +
      (Number.parseFloat(style.paddingRight) || 0);
    const pinned = document.querySelector("#pinned-tabs-container");
    const pinnedWidth = pinned?.getBoundingClientRect().width || 0;
    const available = Math.max(0, container.width - padding - pinnedWidth);
    if (available <= 0) return;

    /*
     * Equal tab shares fill a centered shelf that reaches the available
     * row width at four tabs. Editing changes content alignment only.
     * The four-tab threshold follows the requested reference behavior.
     */
    // One centered quarter, then half, three quarters and full width.
    // Highlight never participates in this allocation.
    const count = normalTabs.length;
    const rowWidth = Math.min(available, window.innerWidth * count / 4);
    const equalWidth = rowWidth / count;
    // Highlight changes content alignment, never tab allocation.
    const editingWidth = equalWidth;

    const setPixels = (name, value) => {
      const next = `${value.toFixed(3)}px`;
      if (tabs.style.getPropertyValue(name) !== next) {
        tabs.style.setProperty(name, next);
      }
    };
    setPixels("--safari-v8-row-width", rowWidth);
    setPixels("--safari-v8-edit-width", editingWidth);
    const start = container.left +
      (Number.parseFloat(style.paddingLeft) || 0) + pinnedWidth;
    setPixels("--safari-v8-row-offset",
      Math.max(0, Math.min(available - rowWidth,
        (window.innerWidth - rowWidth) / 2 - start)));

    const active = selectedTab();
    for (const [index, tab] of normalTabs.entries()) {
      // The native tab's leading border already contributes one pixel.
      // Only shelf endpoints need a full inset; internal seams stay narrow.
      const startInset = index === 0 ? "2px" : "0px";
      const endInset = index === normalTabs.length - 1 ? "3px" : "0px";
      if (tab.style.getPropertyValue("--safari-v8-pill-start") !== startInset) {
        tab.style.setProperty("--safari-v8-pill-start", startInset);
      }
      if (tab.style.getPropertyValue("--safari-v8-pill-end") !== endInset) {
        tab.style.setProperty("--safari-v8-pill-end", endInset);
      }
      releaseNativeFlex(tab.querySelector(".tab-label-container"));
      tab.classList.toggle(
        "safari-v8-address",
        visible && tab === active
      );
    }

    // Read after the shared layout variables and address owner are applied.
    for (const tab of normalTabs) {
      tab.classList.toggle(
        "safari-v8-icon-only",
        !(visible && tab === active) &&
          tab.getBoundingClientRect().width < 64
      );
    }
  }

  function positionUrlbar() {
    if (noScrollLayoutEnabled()) {
      positionNoScrollAddress();
      return;
    }
    const tab = selectedTab();
    if (!tab) return;

    const rect = tab.getBoundingClientRect();
    /*
     * The input container already supplies the four-pixel optical inset.
     * Adding another outer inset here doubled the first-tab shelf gap.
     */
    const xGap = 0;
    const yGap = 4;

    /*
     * Follow the real selected-tab width. Predicting a 225 px new-tab width
     * conflicts with Firefox's overflow reflow and makes the address surface
     * and new-tab button jump when the native opening animation settles.
     */
    const requestedTabWidth = rect.width;

    /*
     * A newly opened tab can briefly report its final width before Firefox
     * has scrolled it into view. Clamp the fixed overlay to the real tab
     * scrollport so no animation frame can paint over the trailing toolbar.
     */
    const scrollport =
      tabs.hasAttribute("overflow")
        ? tabScrollportRect()
        : null;
    const outsideScrollport = Boolean(scrollport) &&
      (rect.right <= scrollport.left || rect.left >= scrollport.right);
    urlbar.classList.toggle(
      "safari-v8-outside-scrollport", outsideScrollport
    );
    const visibleLeft =
      scrollport
        ? Math.min(scrollport.right, Math.max(rect.left, scrollport.left))
        : rect.left;
    const visibleRight =
      scrollport
        ? Math.min(rect.right, scrollport.right)
        : rect.left + requestedTabWidth;
    const clippedStart =
      Boolean(scrollport) && rect.left < scrollport.left - 0.5;
    const clippedEnd =
      Boolean(scrollport) && rect.right > scrollport.right + 0.5;
    const leftGap = clippedStart ? 0 : xGap;
    const rightGap = clippedEnd ? 0 : xGap;
    const visibleWidth =
      Math.max(1, visibleRight - visibleLeft);
    const stableTabWidth =
      Math.min(requestedTabWidth, visibleWidth);

    urlbar.classList.toggle("safari-v8-clipped-start", clippedStart);
    urlbar.classList.toggle("safari-v8-clipped-end", clippedEnd);
    urlbar.style.setProperty("--safari-v8-left", `${visibleLeft + leftGap}px`);
    urlbar.style.setProperty("--safari-v8-top", `${rect.top + yGap}px`);
    urlbar.style.setProperty("--safari-v8-width", `${Math.max(1, stableTabWidth - leftGap - rightGap)}px`);
    urlbar.style.setProperty("--safari-v8-height", `${Math.max(1, rect.height - yGap * 2)}px`);

    if (visible) {
      clearAddressState();
      tab.classList.add("safari-v8-address");
    }
  }

  function plusButton() {
    if (noScrollLayoutEnabled()) {
      return document.querySelector("#new-tab-button");
    }
    return document.querySelector("#tabs-newtab-button") ||
      document.querySelector("#new-tab-button");
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

  function updatePlusPlacement(animate = false) {
    if (noScrollLayoutEnabled()) {
      updateNoScrollLayout();
      return;
    }
    const plus = plusButton();
    if (!plus) return;

    const normalTabCount = [...gBrowser.tabs].filter(
      tab => !tab.hidden && !tab.closing && !tab.pinned
    ).length;
    const allTabs = visibleAllTabsButton();
    const shouldDetach = normalTabCount >= 9 && Boolean(allTabs);
    const wasDetached = plus.classList.contains("safari-v8-detached-newtab");
    const oldRect = plus.getBoundingClientRect();

    if (!shouldDetach) {
      plusPlacementAnimation?.cancel();
      plusPlacementAnimation = null;
      plus.classList.remove("safari-v8-detached-newtab");
      tabs.style.removeProperty("--safari-v8-trailing-reserve");
      plus.style.removeProperty("--safari-v8-detached-left");
      plus.style.removeProperty("--safari-v8-detached-top");
      return;
    }

    const allTabsRect = allTabs.getBoundingClientRect();
    const width = oldRect.width > 0 ? oldRect.width : 36;
    const height = oldRect.height > 0 ? oldRect.height : 36;
    const left = allTabsRect.left - width - 8;
    const top = allTabsRect.top + (allTabsRect.height - height) / 2;

    plus.style.setProperty(
      "--safari-v8-detached-left",
      `${left}px`
    );
    plus.style.setProperty(
      "--safari-v8-detached-top",
      `${top}px`
    );
    plus.classList.add("safari-v8-detached-newtab");

    /*
     * A fixed plus no longer reserves native layout space. Reserve both its
     * intrusion into the scrollport and the full visual Safe Push expansion.
     * Keep this space while the address is closed too, so focus cannot reflow
     * the row. Add back the previous reserve before measuring to avoid a
     * shrinking/growing feedback loop on subsequent renders.
     */
    const scrollport = tabScrollportRect();
    // Overflow already expands the real source tab and reserves the native
    // toolbar plus. Preserve the ordinary-layout reserve for underflow,
    // but do not measure or apply it inside the scrolling layout.
    if (scrollport && !tabs.hasAttribute("overflow")) {
      const previousReserve = Number.parseFloat(
        tabs.style.getPropertyValue("--safari-v8-trailing-reserve")
      ) || 0;
      const reserve = Math.max(
        0,
        scrollport.right + previousReserve -
          (left - safetyGap) + preferredExpansion
      );
      tabs.style.setProperty(
        "--safari-v8-trailing-reserve",
        `${reserve}px`
      );
    }

    // Never replay an in-row position across the trailing toolbar.
    if (!animate || !wasDetached ||
        oldRect.width <= 0 || oldRect.height <= 0) return;

    const newRect = plus.getBoundingClientRect();
    const deltaX = oldRect.left - newRect.left;
    const deltaY = oldRect.top - newRect.top;

    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;

    plusPlacementAnimation?.cancel();
    plusPlacementAnimation = plus.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: "translate(0, 0)" }
      ],
      {
        duration: 180,
        easing: "cubic-bezier(.2, .8, .2, 1)"
      }
    );
    plusPlacementAnimation.finished
      .catch(() => null)
      .then(() => {
        plusPlacementAnimation = null;
      });
  }

  function tabScrollportRect() {
    const arrowscrollbox = document.querySelector("#tabbrowser-arrowscrollbox");
    if (!arrowscrollbox) return null;

    const inner =
      arrowscrollbox.shadowRoot?.querySelector('[part="scrollbox"]') ||
      arrowscrollbox.shadowRoot?.getElementById("scrollbox");
    const rect = (inner || arrowscrollbox).getBoundingClientRect();

    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function safeExpansion(plus, active) {
    if (tabs.hasAttribute("overflow")) {
      const scrollport = tabScrollportRect();
      const activeRect = active?.getBoundingClientRect();
      if (!scrollport || !activeRect) return { expansion: 0, leftShift: 0 };

      /*
       * Once expanded, activeRect.width includes the previous expansion.
       * Reusing that value can reduce the next computed expansion and create a
       * layout race that only a later focus/reflow corrects. Always calculate
       * from the immutable compact source width captured before first reflow.
       */
      const storedSourceWidth = Number.parseFloat(
        active.style.getPropertyValue("--safari-v8-source-width")
      );
      const sourceWidth =
        Number.isFinite(storedSourceWidth) && storedSourceWidth > 0
          ? storedSourceWidth
          : activeRect.width;

      /*
       * Overflow expansion is represented by the real hidden source tab.
       * Firefox therefore reflows following tabs normally instead of letting
       * fixed or translated layers overlap neighbouring tabs and toolbar UI.
       */
      const expansion = Math.min(
        preferredExpansion,
        Math.max(0, scrollport.width - sourceWidth - safetyGap * 2)
      );

      return { expansion, leftShift: 0 };
    }

    const activeRect = active?.getBoundingClientRect();
    if (!activeRect || activeRect.width <= 0) {
      return { expansion: 0, leftShift: 0 };
    }

    /*
     * Non-overflow expansion is a fixed visual contract. Calculating it from
     * transient toolbar or plus-button geometry made Esc followed by Cmd+L
     * reopen the same tab at a different width.
     */
    return {
      expansion: preferredExpansion,
      leftShift: 0
    };
  }

  function applyPush(openingProgress = null) {
    if (noScrollLayoutEnabled()) {
      updateNoScrollLayout();
      urlbar.style.setProperty("--safari-v8-expand", "0px");
      urlbar.style.setProperty("--safari-v8-left-shift", "0px");
      return;
    }
    // During opening, only the geometry sampler may advance expansion.
    // Focus/navigation callbacks must not replace partial progress with 1.
    if (newTabOpening && openingProgress === null) return;
    openingProgress ??= 1;

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

    /*
     * Rapid TabOpen transactions can select a second tab before the first
     * transaction's delayed focus callback runs. Retire every stale expanded
     * source before sizing the current selection, so exactly one source tab
     * can own the address surface.
     */
    tabs.querySelectorAll(".safari-v8-source-expanded").forEach(tab => {
      if (tab === active) return;
      tab.classList.remove("safari-v8-source-expanded");
      tab.style.removeProperty("--safari-v8-source-width");
      tab.style.removeProperty("--safari-v8-source-expand");
    });

    let { expansion, leftShift } = safeExpansion(plus, active);

    if (expansion < 8) {
      clearPush();
      return;
    }

    const overflowing = tabs.hasAttribute("overflow");

    // Native opening and visual expansion share one eased progress value.
    // Keep the established real-layout overflow path unchanged.
    if (!overflowing) {
      expansion *= Math.max(0, Math.min(1, openingProgress));
    }

    if (overflowing) {
      /*
       * Widen the real, visually hidden selected tab so Firefox's own flex
       * layout pushes following tabs aside. The URL overlay then follows the
       * resulting geometry without translating children outside the scroller.
       */
      const currentWidth = active.getBoundingClientRect().width;

      /*
       * Store the compact source width only once. Reading it again after the
       * expansion class has reflowed the tab would compound the width on each
       * render and would also make Firefox's flex sizing unstable.
       */
      if (!active.classList.contains("safari-v8-source-expanded")) {
        active.style.setProperty(
          "--safari-v8-source-width",
          `${currentWidth}px`
        );
        active.style.setProperty(
          "--safari-v8-source-expand",
          `${expansion}px`
        );
        active.classList.add("safari-v8-source-expanded");
      } else {
        active.style.setProperty(
          "--safari-v8-source-expand",
          `${expansion}px`
        );
      }
      urlbar.style.setProperty("--safari-v8-expand", "0px");
      urlbar.style.setProperty("--safari-v8-left-shift", "0px");

      /*
       * Read the reflowed rectangle immediately. The source tab is invisible,
       * so this produces one coherent foreground frame rather than a delayed
       * overlay expansion over the old tab positions.
       */
      positionUrlbar();
    } else {
      active.classList.remove("safari-v8-source-expanded");
      active.style.removeProperty("--safari-v8-source-width");
      active.style.removeProperty("--safari-v8-source-expand");
      urlbar.style.setProperty(
        "--safari-v8-expand",
        `${expansion}px`
      );
      urlbar.style.setProperty(
        "--safari-v8-left-shift",
        `${leftShift}px`
      );
    }

    /*
     * Reconcile the desired push targets instead of clearing and rebuilding
     * them on every render. Removing and immediately restoring the class
     * restarted the translate transition during the delayed settle render,
     * producing a 96 px -> 0 px -> 96 px reversal.
     */
    const desired = new Set();
    let afterActive = false;

    /*
     * Transforms on children of an overflowing arrowscrollbox escape its
     * logical scroll geometry. In overflow mode the foreground address pill
     * expands over neighbouring tabs instead; its measured bounds remain
     * clamped to the real scrollport.
     */
    if (!overflowing) {
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

      if (
        plus &&
        !plus.classList.contains("safari-v8-detached-newtab")
      ) {
        desired.add(plus);
      }
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
    /*
     * The former external blend surface is disabled, so a second copied glyph
     * is no longer needed. Animate Firefox's real glyph directly. One painted
     * element means no destination shadow and no duplicate search glass.
     */
    cleanGlyph.classList.remove("visible");
    glyph.style.removeProperty("opacity");

    if (noScrollLayoutEnabled()) {
      pendingGlyphHandoffRect = null;
      return;
    }
    if (!visible || !pendingGlyphHandoffRect) return;

    const rect = glyph.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const sourceRect = pendingGlyphHandoffRect;
    pendingGlyphHandoffRect = null;

    const deltaX =
      sourceRect.left + sourceRect.width / 2 -
      (rect.left + rect.width / 2);
    const deltaY =
      sourceRect.top + sourceRect.height / 2 -
      (rect.top + rect.height / 2);

    glyphHandoffAnimation?.cancel();
    glyphHandoffAnimation = glyph.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: "translate(0, 0)" }
      ],
      {
        duration: 150,
        easing: "cubic-bezier(.2, .8, .2, 1)"
      }
    );

    glyphHandoffAnimation.finished
      .catch(() => null)
      .then(() => {
        glyphHandoffAnimation = null;
      });
  }

  function refreshAddressControls() {
    if (!visible || navigationShiftInProgress || newTabOpening) return;
    if (closeHover) positionCloseButton();
    if (reloadHover) positionReloadButton();
  }

  function onAddressInput() {
    // Input may precede Firefox's usertyping attribute update.
    hideReload();
    updateGlyph();
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
      refreshAddressControls();
    });
  }

  function positionShelfGeometryProbe() {
    if (noScrollLayoutEnabled()) {
      const row = document.querySelector("#tabbrowser-arrowscrollbox");
      const rect = row?.getBoundingClientRect();
      const tab = selectedTab();
      const tabRect = tab?.getBoundingClientRect();
      if (!rect || !tabRect || rect.width <= 0) {
        shelfProbe.classList.remove("visible");
        return;
      }
      shelfProbe.style.setProperty("--probe-left", `${rect.left}px`);
      shelfProbe.style.setProperty("--probe-top", `${tabRect.top + 4}px`);
      shelfProbe.style.setProperty("--probe-width", `${rect.width}px`);
      shelfProbe.style.setProperty("--probe-height",
        `${Math.max(1, tabRect.height - 8)}px`);
      shelfProbe.classList.remove("continues-before", "continues-after");
      shelfProbe.classList.toggle("address-mode", visible);
      shelfProbe.classList.add("visible");
      return;
    }
    const overflowing = !noScrollLayoutEnabled() &&
      tabs.hasAttribute("overflow");
    const scrollport = tabScrollportRect();
    const allNormalTabs = [...tabs.querySelectorAll(
      ".tabbrowser-tab:not([pinned], [hidden])"
    )].filter(tab => {
      const rect = tab.getBoundingClientRect();
      return !tab.closing && rect.width > 0 && rect.height > 0;
    });
    const normalTabs = allNormalTabs.filter(tab => {
      const rect = tab.getBoundingClientRect();
      return (
        !overflowing || !scrollport ||
        (rect.right > scrollport.left && rect.left < scrollport.right)
      );
    });

    if (!scrollport) {
      for (const tab of allNormalTabs) {
        tab.classList.remove(
          "safari-v8-clipped-start",
          "safari-v8-clipped-end"
        );
      }
      shelfProbe.classList.remove(
        "visible",
        "continues-before",
        "continues-after"
      );
      return;
    }

    for (const tab of allNormalTabs) {
      const rect = tab.getBoundingClientRect();
      tab.classList.toggle(
        "safari-v8-clipped-start",
        overflowing && rect.left < scrollport.left - 0.5 &&
          rect.right > scrollport.left + 0.5
      );
      tab.classList.toggle(
        "safari-v8-clipped-end",
        overflowing && rect.right > scrollport.right + 0.5 &&
          rect.left < scrollport.right - 0.5
      );
    }

    if (!normalTabs.length) {
      shelfProbe.classList.remove("visible");
      return;
    }

    const firstBackground = normalTabs[0]
      .querySelector(".tab-background")?.getBoundingClientRect();
    const lastBackground = normalTabs.at(-1)
      .querySelector(".tab-background")?.getBoundingClientRect();
    const plus = plusButton();
    const plusParticipates =
      !noScrollLayoutEnabled() && plus &&
      !plus.classList.contains("safari-v8-detached-newtab");
    const plusRect =
      plusParticipates
        ? plus.getBoundingClientRect()
        : null;
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
    /*
     * The native overflow arrows sit outside the shelf. Clamp both rounded
     * shelf ends to the real content scrollport instead of bleeding beneath
     * either arrow or into the toolbar controls.
     */
    const firstTabRect = allNormalTabs[0]?.getBoundingClientRect();
    const lastTabRect = allNormalTabs.at(-1)?.getBoundingClientRect();
    const continuesBefore =
      overflowing && Boolean(firstTabRect) &&
      firstTabRect.left < scrollport.left - 0.5;
    const continuesAfter =
      overflowing && Boolean(lastTabRect) &&
      lastTabRect.right > scrollport.right + 0.5;

    /*
     * Safe Push moves painted tabs and the plus beyond their compact
     * layout bounds. Only actual overflow makes the scrollport a clip
     * boundary; otherwise retain the measured address/plus boundary.
     */
    const clampedLeft = overflowing
      ? Math.max(left, scrollport.left)
      : left;
    const right = overflowing
      ? Math.min(desiredRight, rightLimit, scrollport.right)
      : Math.min(desiredRight, rightLimit);
    const clampedRight = Math.max(clampedLeft, right);

    shelfProbe.classList.toggle("continues-before", continuesBefore);
    shelfProbe.classList.toggle("continues-after", continuesAfter);
    /*
     * Background rectangles are visually scaled for selected and hovered
     * pills. Deriving shelf height from those painted rectangles made the
     * shelf pulse vertically when selection moved between tabs.
     *
     * The real tab rectangle is stable at 44 px. Firefox's tab background
     * occupies the central 36 px, with a 4 px inset above and below.
     */
    const firstVisibleTabRect =
      normalTabs[0].getBoundingClientRect();

    const stableTop =
      firstVisibleTabRect.top + 4;

    const stableBottom =
      firstVisibleTabRect.bottom - 4;

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

    shelfProbe.style.setProperty("--probe-left", `${clampedLeft}px`);
    shelfProbe.style.setProperty("--probe-top", `${top}px`);
    shelfProbe.style.setProperty("--probe-width", `${Math.max(1, clampedRight - clampedLeft)}px`);
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
      if (noScrollLayoutEnabled()) {
        positionUrlbar();
        positionAddressSurface();
      }
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
      /*
       * Firefox owns the complete native new-tab flex animation. Rendering the
       * address transaction from ResizeObserver or focus events during that
       * interval was the source of the frame-by-frame plus-button movement.
       */
      if (newTabOpening) return;

      updateAllSafariDisplayLabels();
      updatePlusPlacement();
      positionUrlbar();
      applyPush();
      updateScrollEdgeState();
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

    if (!newTabOpening) {
      const icon = tab.querySelector(".tab-icon-stack");
      const rect = icon?.getBoundingClientRect();
      pendingGlyphHandoffRect =
        rect && rect.width > 0 && rect.height > 0
          ? {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height
            }
          : null;
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
    applyPush();
    scrollSelectedTabIntoView();
    positionUrlbar();
    positionAddressSurface();
    updateGlyph();

    if (noScrollLayoutEnabled() && contentOrigin?.width > 0) {
      pendingGlyphHandoffRect = null;
      const destination = glyph.getBoundingClientRect();
      const delta = contentOrigin.left + contentOrigin.width / 2 -
        destination.left - destination.width / 2;
      animateContentHandoff(glyphSlot, delta);
      animateContentHandoff(
        urlbar.querySelector(".urlbar-input-box") || input, delta
      );
    }

    requestAnimationFrame(() => {
      if (noScrollLayoutEnabled() && (
        !visible || addressOwner !== tab ||
        selectedTab() !== tab || tab.closing || tab.hidden
      )) return;
      gURLBar.focus();
      gURLBar.select();
      revealSelectedAddressFromStart();
      updateGlyph();
      positionFinalNavigationGeometry();
    });
  }

  function closeUrlbar() {
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
    clearPush();
    positionAddressSurface();
    positionShelfGeometryProbe();
    followShelfGeometryAnimation();

    if (noScrollLayoutEnabled() && wasVisible && tab) {
      // Never transfer the previous address's motion to another tab.
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
    const addressTarget = visible && target === addressOwner;
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
    const centerX = iconRect?.width > 0
      ? iconRect.left + iconRect.width / 2
      : rect.left + (addressTarget ? 20 : 18);
    const centerY = iconRect?.height > 0
      ? iconRect.top + iconRect.height / 2
      : rect.top + rect.height / 2;

    closeButton.style.setProperty("--close-left", `${centerX - size / 2}px`);
    closeButton.style.setProperty("--close-top", `${centerY - size / 2}px`);

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
      !(visible && urlbar.hasAttribute("usertyping")) &&
      spec !== "about:newtab" &&
      spec !== "about:home" &&
      spec !== "about:blank";
  }

  function positionReloadButton() {
    if (visible && urlbar.hasAttribute("usertyping")) {
      hideReload();
      return;
    }
    const rect = reloadTargetRect();
    if (!rect) return;

    updateControlColor();
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
    reloadButton.classList.add("visible");
  }

  function suppressControlsDuringScroll() {
    controlsSuppressedByScroll = true;
    clearTimeout(scrollControlTimer);
    hideClose();
    hideReload();
    tabCloseTarget?.classList.remove("safari-v8-close-over-icon");
    tabCloseTarget = null;

    scrollControlTimer = setTimeout(() => {
      controlsSuppressedByScroll = false;
      scrollControlTimer = 0;
    }, 120);
  }

  function forwardTabScrollWheel(event) {
    if (noScrollLayoutEnabled()) return;
    // Forward once, and only while the horizontal tab strip can scroll.
    if (event.defaultPrevented || !tabs.hasAttribute("overflow")) return;
    const arrowscrollbox =
      tabs.arrowScrollbox ||
      document.querySelector("#tabbrowser-arrowscrollbox");

    /*
     * Hide fixed hover controls before delegating the original WheelEvent.
     * Firefox then retains its native axis filtering, delta conversion,
     * acceleration and smooth-scroll state.
     */
    suppressControlsDuringScroll();

    if (typeof arrowscrollbox?.on_wheel === "function") {
      arrowscrollbox.on_wheel(event);
      return;
    }

    const deltaX = event.deltaX || 0;
    const deltaY = event.deltaY || 0;
    const amount = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    if (!amount) return;

    event.preventDefault();
    event.stopPropagation();

    const inner =
      arrowscrollbox?.shadowRoot?.querySelector('[part="scrollbox"]') ||
      arrowscrollbox?.shadowRoot?.getElementById("scrollbox") ||
      arrowscrollbox;
    inner?.scrollBy?.({ left: amount, top: 0, behavior: "auto" });
  }

  function updateScrollEdgeState() {
    const arrow = tabs.arrowScrollbox ||
      document.querySelector("#tabbrowser-arrowscrollbox");
    const inner = arrow?.scrollbox ||
      arrow?.shadowRoot?.querySelector('[part="scrollbox"]');
    if (!inner || !tabs.hasAttribute("overflow")) {
      tabs.classList.remove("safari-v8-at-scroll-end");
      return;
    }

    /*
     * Native disabled/scrolledtoend propagation waits for animation frames.
     * Paint the exhausted direction from actual scroll geometry immediately,
     * without changing native attributes, button layout or scrolling.
     */
    const rtl = getComputedStyle(inner).direction === "rtl";
    const position = rtl ? -inner.scrollLeft : inner.scrollLeft;
    const maximum = rtl
      ? Math.abs(inner.scrollLeftMin ??
          -(inner.scrollWidth - inner.clientWidth))
      : (inner.scrollLeftMax ??
          (inner.scrollWidth - inner.clientWidth));
    tabs.classList.toggle(
      "safari-v8-at-scroll-end",
      Number.isFinite(position) && Number.isFinite(maximum) &&
        maximum - position <= 0.5
    );
  }

  function onTabStripScroll() {
    /*
     * Scroll-induced hit testing can emit pointermove without real pointer
     * motion. Keep controls suppressed until scrolling has been idle briefly.
     */
    suppressControlsDuringScroll();
    updateScrollEdgeState();

    /*
     * The address is fixed outside the native scrollport. Update its clipped
     * geometry in this scroll event, before measuring the shelf. Scheduling
     * render() here left the address one frame behind and reapplied layout
     * expansion during a user-controlled scroll.
     */
    positionUrlbar();
    positionAddressSurface();
    positionShelfGeometryProbe();
  }

  function scrollSelectedTabIntoView() {
    if (noScrollLayoutEnabled()) return false;
    if (!tabs.hasAttribute("overflow")) return false;

    const tab = selectedTab();
    const arrowscrollbox =
      tabs.arrowScrollbox ||
      document.querySelector("#tabbrowser-arrowscrollbox");
    const scrollRect =
      arrowscrollbox?.scrollClientRect ||
      tabScrollportRect();

    if (!tab || !arrowscrollbox || !scrollRect) return false;

    /*
     * Measure after real-layout expansion and move only the missing viewport
     * distance. Applying this synchronously keeps the clipped intermediate
     * address pill and displaced plus button out of the painted sequence.
     */
    const tabRect = tab.getBoundingClientRect();
    const delta =
      tabRect.left < scrollRect.left
        ? tabRect.left - scrollRect.left
        : tabRect.right > scrollRect.right
          ? tabRect.right - scrollRect.right
          : 0;

    if (Math.abs(delta) <= 0.5) {
      updateScrollEdgeState();
      return false;
    }

    const inner =
      arrowscrollbox.shadowRoot?.querySelector('[part="scrollbox"]') ||
      arrowscrollbox.shadowRoot?.getElementById("scrollbox") ||
      arrowscrollbox;

    inner?.scrollBy?.({
      left: delta,
      top: 0,
      behavior: "instant"
    });
    updateScrollEdgeState();
    return true;
  }

  function ensureSelectedTabVisible() {
    cancelAnimationFrame(selectedTabScrollFrame);

    selectedTabScrollFrame = requestAnimationFrame(() => {
      selectedTabScrollFrame = 0;
      scrollSelectedTabIntoView();

      selectedTabScrollFrame = requestAnimationFrame(() => {
        selectedTabScrollFrame = 0;
        positionFinalNavigationGeometry();
      });
    });
  }

  function onPointerMove(event) {
    if (controlsSuppressedByScroll) {
      hideClose();
      hideReload();
      return;
    }

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
    if (noScrollLayoutEnabled()) {
      cancelContentHandoff();
      // Retire the old overlay before another tab can paint beneath it.
      if (!newTabOpening && addressOwner !== selectedTab()) {
        hideCleanGlyph();
        setVisible(false);
        positionAddressSurface();
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
    animateNavigationShiftIfNeeded();

    queueMicrotask(() => {
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
    // Diagnostic only: capture the actual highlighted paint and stacking state.
    requestAnimationFrame(() => {
      if (!newTabOpening && visible && selectedTab()) {
        traceNewTabGeometry(selectedTab(), newTabGeometryToken);
      }
    });
  }

  function onFocusOut() {
    requestAnimationFrame(() => {
      if (newTabOpening) return;

      const focused = document.activeElement;
      if (focused !== input && !urlbar.contains(focused)) {
        closeUrlbar();
      }
    });
  }

  function onKeyDown(event) {
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      event.stopImmediatePropagation();
      openUrlbar();
    }
  }

  function finishStableNewTab(openedTab, token) {
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
    newTabOpening = false;
    // TabOpen can precede native selection: its initial address owner may
    // still be the previous tab. Commit ownership to the validated new tab
    // before finishing geometry, so Cmd+L cannot reopen the same surface.
    if (visible && addressOwner !== openedTab) {
      setVisible(true);
    }
    updatePlusPlacement(true);
    positionUrlbar();
    /* Establish the compact start before committing synchronized growth. */
    urlbar.classList.add("safari-v8-newtab-enter");
    void urlbar.getBoundingClientRect();
    applyPush();
    document.documentElement.classList.remove(
      "safari-v8-opening-reserve"
    );
    scrollSelectedTabIntoView();
    positionUrlbar();
    positionAddressSurface();
    positionShelfGeometryProbe();
    // Flush the final shared geometry before restoring ordinary transitions.
    if (document.documentElement.classList.contains("safari-v8-shared-opening")) {
      void urlbar.getBoundingClientRect();
      document.documentElement.classList.remove("safari-v8-shared-opening");
    }
    /*
     * Follow the same painted address/plus bounds throughout Safe Push.
     * A separate shelf FLIP would animate an already-moving target twice.
     */
    followShelfGeometryAnimation();
    applyGlyph(searchGlyph);
    updateGlyph();
  }

  function waitForStableNewTabGeometry(openedTab, token) {
    cancelAnimationFrame(newTabGeometryFrame);
    if (noScrollLayoutEnabled()) {
      // The new layout has no native min/max-width opening contract.
      // Commit on the next frame; finishStableNewTab validates ownership.
      newTabGeometryFrame = requestAnimationFrame(() => {
        newTabGeometryFrame = 0;
        finishStableNewTab(openedTab, token);
      });
      return;
    }

    let previousSignature = "";
    let stableFrames = 0;
    let observedFrames = 0;
    let geometryChanged = false;
    let sharedProgress = 0;
    let sharedOpeningStarted = false;

    const geometrySignature = () => {
      const tabWidths = Array.from(gBrowser.tabs)
        .filter(tab => !tab.hidden && !tab.closing)
        .map(tab => tab.getBoundingClientRect().width.toFixed(2))
        .join(",");

      const plusRect = plusButton()?.getBoundingClientRect();
      const plusLeft =
        plusRect && plusRect.width > 0
          ? plusRect.left.toFixed(2)
          : "none";

      const scrollport = tabScrollportRect();
      const selectedRect = openedTab.getBoundingClientRect();

      return [
        tabWidths,
        plusLeft,
        scrollport?.left.toFixed(2) ?? "none",
        scrollport?.right.toFixed(2) ?? "none",
        selectedRect.left.toFixed(2),
        selectedRect.right.toFixed(2)
      ].join("|");
    };

    const sample = () => {
      if (
        token !== newTabGeometryToken ||
        openedTab !== gBrowser.selectedTab ||
        openedTab.closing ||
        openedTab.hidden
      ) {
        return;
      }

      /*
       * In ordinary layout, use the native min-width transition's already
       * eased progress for Safe Push too. This avoids braking to zero and
       * starting a second expansion curve after native opening.
       * Overflow retains its established real-layout handoff for now.
       */
      if (!tabs.hasAttribute("overflow")) {
        const widthAnimation = openedTab.getAnimations().find(
          animation => animation.transitionProperty === "min-width"
        );
        const progress = widthAnimation?.effect
          ?.getComputedTiming().progress;
        if (typeof progress === "number") {
          sharedOpeningStarted = true;
          sharedProgress = Math.max(sharedProgress, progress);
        } else if (sharedOpeningStarted && openedTab.hasAttribute("fadein")) {
          sharedProgress = 1;
        }
        if (sharedOpeningStarted) {
          document.documentElement.classList.add("safari-v8-shared-opening");
          applyPush(sharedProgress);
        }
      } else if (document.documentElement.classList.contains(
        "safari-v8-shared-opening"
      )) {
        clearPush();
      }

      positionUrlbar();
      positionAddressSurface();
      positionShelfGeometryProbe();
      applyGlyph(searchGlyph);

      const signature = geometrySignature();
      observedFrames += 1;

      if (previousSignature && signature === previousSignature) {
        stableFrames += 1;
      } else {
        if (previousSignature) geometryChanged = true;
        stableFrames = 0;
      }

      previousSignature = signature;

      /*
       * Native max-width can keep transitioning after flex layout has
       * already reached its final painted width. Do not wait for that
       * invisible tail: after fadein and observed motion, one unchanged
       * whole-row sample can hand off to synchronized address expansion.
       * Keep native completion for motionless openings and the legacy
       * fallback for versions without the native API.
       */
      const hasNativeCompletion =
        typeof tabs.openAnimationFinished === "function";
      const nativeOpeningFinished =
        hasNativeCompletion && tabs.openAnimationFinished(openedTab);
      const changedAndStable =
        openedTab.hasAttribute("fadein") &&
        // In overflow, real source expansion replaces native width rules.
        // Do not cancel native opening at a temporary flex-layout plateau.
        (!tabs.hasAttribute("overflow") || !hasNativeCompletion) &&
        (!sharedOpeningStarted || sharedProgress >= 1) &&
        geometryChanged && stableFrames >= 1;
      const motionlessAndStable =
        !geometryChanged && observedFrames >= 12 && stableFrames >= 8;

      if (
        nativeOpeningFinished ||
        changedAndStable ||
        (!hasNativeCompletion && (
          motionlessAndStable ||
          observedFrames >= 90
        ))
      ) {
        newTabGeometryFrame = 0;
        finishStableNewTab(openedTab, token);
        return;
      }

      newTabGeometryFrame = requestAnimationFrame(sample);
    };

    newTabGeometryFrame = requestAnimationFrame(sample);
  }


  /* Temporary diagnostic: observe geometry without changing animation state. */
  function traceNewTabGeometry(openedTab, token) {
    const started = performance.now();
    const samples = [];
    const write = error => {
      try {
        const file = Services.dirsvc.get(
          "ProfD", Components.interfaces.nsIFile
        );
        file.append("safari-opening-trace.json");
        const stream = Components.classes[
          "@mozilla.org/network/file-output-stream;1"
        ].createInstance(Components.interfaces.nsIFileOutputStream);
        const data = JSON.stringify({
          token, error: error ? String(error.stack || error) : null, samples,
          layoutDiagnostics: (() => {
            const properties = [
              "display", "width", "min-width", "max-width", "flex",
              "box-sizing", "padding-left", "padding-right",
              "margin-left", "margin-right", "justify-content",
              "justify-self", "align-self", "grid-template-columns",
              "grid-column", "grid-area", "background-color",
              "color", "color-scheme", "opacity", "visibility",
              "position", "z-index", "isolation", "transform", "scale",
              "height", "margin-top", "margin-bottom",
              "border-top-left-radius", "border-top-right-radius",
              "border-bottom-left-radius", "border-bottom-right-radius",
              "border-top-width", "border-left-width", "box-shadow",
              "background-image", "mix-blend-mode", "filter", "backdrop-filter",
              "--safari-v8-row-width", "--safari-v8-edit-width",
              "--safari-v8-row-offset"
            ];
            const inspect = element => {
              if (!element) return null;
              const style = getComputedStyle(element);
              return {
                tag: element.localName,
                id: element.id,
                classes: element.getAttribute("class"),
                rect: box(element),
                bounds: (() => {
                  const r = element.getBoundingClientRect();
                  return {left: r.left, top: r.top, width: r.width, height: r.height};
                })(),
                style: Object.fromEntries(properties.map(
                  name => [name, style.getPropertyValue(name)]
                )),
                inline: element.getAttribute("style")
              };
            };
            const arrow = document.querySelector("#tabbrowser-arrowscrollbox");
            return {
              visualPolishDiagnostics: {
                userAgent: navigator.userAgent,
                devicePixelRatio: window.devicePixelRatio,
                cornerShapeSupported: CSS.supports("corner-shape", "round"),
                superellipseSupported: CSS.supports(
                  "corner-shape", "superellipse(1.1)"
                ),
                controls: [closeButton, reloadButton].map(element => {
                  const style = getComputedStyle(element);
                  const r = element.getBoundingClientRect();
                  return {
                    id: element.id,
                    classes: element.getAttribute("class"),
                    bounds: {
                      left: r.left, top: r.top,
                      width: r.width, height: r.height
                    },
                    backgroundImage: style.backgroundImage,
                    backgroundSize: style.backgroundSize,
                    backgroundPosition: style.backgroundPosition,
                    fill: style.fill,
                    fillOpacity: style.fillOpacity,
                    visibility: style.visibility,
                    shadow: style.boxShadow
                  };
                })
              },
              rootClasses: document.documentElement.className,
              viewport: window.innerWidth,
              row: inspect(arrow),
              shadow: arrow?.shadowRoot
                ? [...arrow.shadowRoot.querySelectorAll("[part]")].map(inspect)
                : [],
              tabs: [...gBrowser.tabs].filter(
                tab => !tab.hidden && !tab.closing && !tab.pinned
              ).map(tab => ({
                tab: inspect(tab),
                stack: inspect(tab.querySelector(".tab-stack")),
                background: inspect(tab.querySelector(".tab-background")),
                content: inspect(tab.querySelector(".tab-content")),
                children: [...(tab.querySelector(".tab-content")?.children || [])]
                  .map(inspect)
              })),
              address: inspect(urlbar),
              addressBackgrounds: [...urlbar.querySelectorAll(
                ".urlbar-background, #urlbar-background"
              )].map(inspect),
              shelf: inspect(shelfProbe),
              paintAncestors: [urlbar, shelfProbe].map(element => {
                const chain = [];
                for (let node = element; node; node = node.parentElement) {
                  chain.push(inspect(node));
                }
                return chain;
              }),
              addressContainer: inspect(inputContainer),
              addressInput: inspect(input),
              leadingGlyph: inspect(glyph),
              leadingGlyphSlot: inspect(glyphSlot),
              inputBox: inspect(urlbar.querySelector(".urlbar-input-box")),
              paintOrderAtAddress: (() => {
                const r = inputContainer.getBoundingClientRect();
                // Sample away from text and icons, inside the painted pill.
                return document.elementsFromPoint(
                  r.left + r.width * 0.75, r.top + r.height - 5
                ).map(inspect);
              })(),
              selection: {
                background: getComputedStyle(input, "::selection").backgroundColor,
                color: getComputedStyle(input, "::selection").color
              }
            };
          })()
        }, null, 2);
        stream.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
        try {
          stream.write(data, data.length);
        } finally {
          stream.close();
        }
      } catch (failure) {
        console.error("Safari opening trace write:", failure);
      }
    };
    const box = element => {
      const r = element?.getBoundingClientRect();
      return r ? [r.left, r.width, r.right].map(n => +n.toFixed(3)) : null;
    };
    const sample = () => {
      if (token !== newTabGeometryToken) {
        write("Superseded by another transaction");
        return;
      }
      try {
        const style = getComputedStyle(openedTab);
        samples.push({
          ms: +(performance.now() - started).toFixed(2),
          opening: newTabOpening,
          nativeDone: typeof tabs.openAnimationFinished === "function"
            ? tabs.openAnimationFinished(openedTab) : null,
          selected: openedTab === gBrowser.selectedTab,
          fadein: openedTab.hasAttribute("fadein"),
          overflow: tabs.hasAttribute("overflow"),
          normalTabCount: [...gBrowser.tabs].filter(
            tab => !tab.hidden && !tab.closing && !tab.pinned
          ).length,
          toolbar: box(toolbar),
          tabContainer: box(tabs),
          scrollport: (() => {
            const rect = tabScrollportRect();
            return rect ? [rect.left, rect.width, rect.right] : null;
          })(),
          allTabs: box(visibleAllTabsButton()),
          plusDetached: Boolean(plusButton()?.classList.contains(
            "safari-v8-detached-newtab"
          )),
          trailingReserve: tabs.style.getPropertyValue(
            "--safari-v8-trailing-reserve"
          ),
          plusCandidates: ["#tabs-newtab-button", "#new-tab-button"]
            .flatMap(selector => [...document.querySelectorAll(selector)]
              .map(element => ({
                selector,
                rect: box(element),
                display: getComputedStyle(element).display,
                visibility: getComputedStyle(element).visibility,
                detached: element.classList.contains(
                  "safari-v8-detached-newtab"
                ),
                parent: element.parentElement?.id
              }))),
          scrollState: (() => {
            const arrow = tabs.arrowScrollbox ||
              document.querySelector("#tabbrowser-arrowscrollbox");
            const inner = arrow?.shadowRoot
              ?.querySelector('[part="scrollbox"]');
            return {
              left: inner?.scrollLeft,
              width: inner?.clientWidth,
              total: inner?.scrollWidth,
              attributes: arrow ? [...arrow.attributes]
                .map(a => [a.name, a.value]) : [],
              buttons: ["scrollbutton-up", "scrollbutton-down"].map(id => {
                const button = arrow?.shadowRoot?.getElementById(id) ||
                  document.getElementById(id);
                return button ? {
                  id, rect: box(button),
                  disabled: button.disabled,
                  attributes: [...button.attributes]
                    .map(a => [a.name, a.value]),
                  visibility: getComputedStyle(button).visibility,
                  opacity: getComputedStyle(button).opacity
                } : {id, missing: true};
              })
            };
          })(),
          trailingControls: [
            "#nav-bar-overflow-button", "#unified-extensions-button",
            "#downloads-button", "#PanelUI-menu-button"
          ].flatMap(selector => [...document.querySelectorAll(selector)]
            .filter(element => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return rect.width > 0 && rect.height > 0 &&
                style.display !== "none" && style.visibility !== "hidden";
            })
            .map(element => ({selector, rect: box(element)}))),
          tab: box(openedTab),
          url: box(urlbar),
          plus: box(plusButton()),
          shelf: box(shelfProbe),
          expansion: urlbar.style.getPropertyValue("--safari-v8-expand"),
          transition: [style.transitionProperty, style.transitionDuration,
            style.transitionDelay],
          animations: openedTab.getAnimations().map(a => ({
            property: a.transitionProperty ?? null,
            state: a.playState,
            time: a.currentTime,
            progress: a.effect?.getComputedTiming().progress
          }))
        });
        if (performance.now() - started < 850) {
          requestAnimationFrame(sample);
        } else {
          write(null);
        }
      } catch (error) {
        write(error);
      }
    };
    write(null);
    requestAnimationFrame(sample);
  }

  function onTabOpen(event) {
    // A new tab must not inherit the previous tab's hover ownership
    // or fixed control coordinates while opening geometry is changing.
    hideClose();
    hideReload();
    tabCloseTarget = null;
    clearTimeout(controlHideTimer);
    cancelContentHandoff();
    clearTimeout(newTabFocusTimer);
    cancelAnimationFrame(newTabGeometryFrame);

    const openedTab = event.target;
    const token = ++newTabGeometryToken;
    newTabOpening = true;
    if (!noScrollLayoutEnabled()) {
      document.documentElement.classList.add(
        "safari-v8-opening-reserve"
      );
    }

    /*
     * Replace Firefox's native "Ny flik" face inside TabOpen, before the next
     * painted frame. The real URL field follows the native opening width with
     * zero extension; the recovered expansion and plus-button geometry are
     * committed only when the row is stable.
     */
    hideCleanGlyph();
    urlbar.classList.remove("safari-v8-newtab-enter");
    clearPush();
    // Reserve and anchor the plus before native opening starts painting.
    // Waiting until finishStableNewTab replayed an already-pushed position.
    updatePlusPlacement();
    updateSafariDisplayLabel(openedTab);
    setVisible(true);

    urlbar.style.setProperty("--safari-v8-expand", "0px");
    urlbar.style.setProperty("--safari-v8-left-shift", "0px");

    positionUrlbar();
    positionAddressSurface();
    positionShelfGeometryProbe();
    applyGlyph(searchGlyph);

    gURLBar.focus();
    gURLBar.select();
    revealSelectedAddressFromStart();

    queueMicrotask(animateNavigationShiftIfNeeded);
    waitForStableNewTabGeometry(openedTab, token);
    traceNewTabGeometry(openedTab, token);
  }

  function onTabClose(event) {
    if (!noScrollLayoutEnabled()) return;
    // TabClose can precede Firefox's native closing attribute.
    // Retire every painted descendant before clearing address ownership.
    event.target.classList.add("safari-v8-retiring");
    cancelContentHandoff();
    hideClose();
    hideReload();
    if (event.target === addressOwner) {
      hideCleanGlyph();
      setVisible(false);
      positionAddressSurface();
    }
    // TabClose precedes the native closing flag on some Firefox versions.
    // Defer allocation to the event's completed native state, not a timer.
    queueMicrotask(() => {
      updateNoScrollLayout();
      positionUrlbar();
      positionAddressSurface();
      positionShelfGeometryProbe();
      followShelfGeometryAnimation();
    });
  }

  const layoutEvents = ["TabClose", "TabMove", "TabPinned", "TabUnpinned"];

  urlbar.classList.add("safari-v8-moving");
  tabs.addEventListener("pointerdown", onTabPointerDown, true);
  tabs.addEventListener("click", onTabClick);
  tabs.addEventListener("TabSelect", onTabSelect);
  tabs.addEventListener("TabOpen", onTabOpen);
  tabs.addEventListener("TabClose", onTabClose);
  layoutEvents.forEach(name => tabs.addEventListener(name, settle));
  const tabScrollbox = document.querySelector("#tabbrowser-arrowscrollbox");
  tabScrollbox?.addEventListener("scroll", onTabStripScroll, { passive: true });
  tabScrollbox?.shadowRoot
    ?.querySelector('[part="scrollbox"]')
    ?.addEventListener("scroll", onTabStripScroll, { passive: true });
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", settle);
  closeButton.addEventListener("pointerdown", blockClosePress, true);
  closeButton.addEventListener("mousedown", blockClosePress, true);
  closeButton.addEventListener("click", closeSelectedTab, true);
  // The fixed address input is outside the tab strip's event chain.
  // Capture before input descendants can consume horizontal wheel events.
  urlbar.addEventListener("wheel", forwardTabScrollWheel, {
    passive: false, capture: true
  });
  closeButton.addEventListener("wheel", forwardTabScrollWheel, { passive: false });
  reloadButton.addEventListener("pointerdown", blockReloadPress, true);
  reloadButton.addEventListener("mousedown", blockReloadPress, true);
  reloadButton.addEventListener("click", reloadSelectedTab, true);
  reloadButton.addEventListener("wheel", forwardTabScrollWheel, { passive: false });

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

  input.addEventListener("input", onAddressInput, true);
  input.addEventListener("select", updateGlyph, true);
  input.addEventListener("focus", updateGlyph, true);

  tabs.addEventListener("TabAttrModified", updateGlyph);
  tabs.addEventListener("TabAttrModified", onSafariTabAttrModified);

  resizeObserver = new ResizeObserver(render);
  resizeObserver.observe(toolbar);

  window.__safariCompactCleanup = () => {
    noScrollShadowStyle?.remove();
    noScrollShadowStyle = null;
    for (const [element, value] of noScrollFlexAttributes) {
      if (!element.hasAttribute("flex")) element.setAttribute("flex", value);
    }
    noScrollFlexAttributes.clear();
    cancelContentHandoff();
    document.documentElement.classList.remove("safari-v8-no-scroll");
    tabs.style.removeProperty("--safari-v8-row-width");
    tabs.style.removeProperty("--safari-v8-edit-width");
    tabs.style.removeProperty("--safari-v8-row-offset");
    for (const tab of gBrowser.tabs) {
      tab.classList.remove("safari-v8-icon-only");
      tab.style.removeProperty("--safari-v8-pill-start");
      tab.style.removeProperty("--safari-v8-pill-end");
    }
    document.documentElement.classList.remove(
      "safari-v8-opening-reserve"
    );
    cancelAnimationFrame(frame);
    cancelAnimationFrame(glyphFrame);
    cancelAnimationFrame(selectedTabScrollFrame);
    cancelAnimationFrame(newTabGeometryFrame);
    newTabGeometryToken += 1;
    glyphHandoffAnimation?.cancel();
    glyphHandoffAnimation = null;
    plusPlacementAnimation?.cancel();
    plusPlacementAnimation = null;
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
    clearTimeout(scrollControlTimer);
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
    tabs.removeEventListener("TabClose", onTabClose);
    tabs.removeEventListener("TabAttrModified", updateGlyph);
    tabs.removeEventListener("TabAttrModified", onSafariTabAttrModified);
    input.removeEventListener("input", onAddressInput, true);
    input.removeEventListener("select", updateGlyph, true);
    input.removeEventListener("focus", updateGlyph, true);

    layoutEvents.forEach(name => tabs.removeEventListener(name, settle));
    tabScrollbox?.removeEventListener("scroll", onTabStripScroll);
    tabScrollbox?.shadowRoot
      ?.querySelector('[part="scrollbox"]')
      ?.removeEventListener("scroll", onTabStripScroll);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", settle);
    closeButton.removeEventListener("pointerdown", blockClosePress, true);
    closeButton.removeEventListener("mousedown", blockClosePress, true);
    closeButton.removeEventListener("click", closeSelectedTab, true);
    urlbar.removeEventListener("wheel", forwardTabScrollWheel, true);
    urlbar.classList.remove("safari-v8-outside-scrollport");
    closeButton.removeEventListener("wheel", forwardTabScrollWheel);
    reloadButton.removeEventListener("pointerdown", blockReloadPress, true);
    reloadButton.removeEventListener("mousedown", blockReloadPress, true);
    reloadButton.removeEventListener("click", reloadSelectedTab, true);
    reloadButton.removeEventListener("wheel", forwardTabScrollWheel);
    closeUrlbar();
    clearAddressState();
    tabs.querySelectorAll(
      ".safari-v8-clipped-start, .safari-v8-clipped-end, .safari-v8-compact-tab"
    ).forEach(tab => {
      tab.classList.remove(
        "safari-v8-clipped-start",
        "safari-v8-clipped-end",
        "safari-v8-compact-tab"
      );
    });
    document.documentElement.classList.remove("safari-v8-address-active");
    urlbar.classList.remove(
      "safari-v8-moving", "safari-v8-visible",
      "safari-v8-exact-close-hover", "safari-v8-newtab-enter"
    );
    ["--safari-v8-left", "--safari-v8-top", "--safari-v8-width", "--safari-v8-height", "--safari-v8-expand", "--safari-v8-left-shift"]
      .forEach(property => urlbar.style.removeProperty(property));
    urlbar.style.removeProperty("--safari-v8-source-scheme");
    urlbar.style.removeProperty("--safari-v8-pill-start");
    urlbar.style.removeProperty("--safari-v8-pill-end");
    glyph.style.removeProperty("list-style-image");
    glyph.classList.remove("safari-v8-search-glyph");
    glyphSlot.classList.remove("safari-v8-close-mask");
    tabs.style.removeProperty("--safari-v8-trailing-reserve");
    tabs.classList.remove("safari-v8-at-scroll-end");
    plusButton()?.classList.remove("safari-v8-detached-newtab");
    plusButton()?.style.removeProperty("--safari-v8-detached-left");
    plusButton()?.style.removeProperty("--safari-v8-detached-top");
    closeButton.remove();
    reloadButton.remove();
    shelfProbe.remove();
    delete window.__safariCompactCleanup;
  };

  clearPush();
  tabs.style.removeProperty("--safari-v8-trailing-reserve");
  document.documentElement.classList.remove(
    "safari-v8-opening-reserve"
  );
  for (const button of document.querySelectorAll(
    "#tabs-newtab-button, #new-tab-button"
  )) {
    button.classList.remove("safari-v8-detached-newtab");
    button.style.removeProperty("--safari-v8-detached-left");
    button.style.removeProperty("--safari-v8-detached-top");
  }
  document.documentElement.classList.add("safari-v8-no-scroll");
  updateNoScrollLayout();
  updateAllSafariDisplayLabels();
  settle();
  traceNewTabGeometry(selectedTab(), newTabGeometryToken);
})();
