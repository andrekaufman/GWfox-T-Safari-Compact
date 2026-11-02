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
  let sharedOpeningGeometry = null;
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
    // No-scroll navigation already follows live toolbar geometry.
    // A second snapshot/FLIP would replay an intermediate shelf position.
    if (noScrollLayoutEnabled()) {
      navigationShiftSnapshot = null;
      return;
    }
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
    // Use one geometry owner for every back/forward state combination.
    // Retire any legacy transaction before it can repaint the shelf.
    if (noScrollLayoutEnabled()) {
      navigationShiftSnapshot = null;
      cancelNavigationShiftAnimations();
      navigationShiftInProgress = false;
      document.documentElement.classList.remove(
        "safari-v8-navigation-shift"
      );
      return;
    }
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
      contentHandoffAnimations =
        contentHandoffAnimations.filter(item => item !== animation);
    });
  }

  function noScrollLayoutEnabled() {
    return document.documentElement.classList.contains(
      "safari-v8-no-scroll"
    );
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
    // Keep the new capsule at its target width instead of growing its
    // text-bearing surface from the native tab's near-zero opening width.
    const opening = sharedOpeningGeometry;
    const targetWidth = opening?.tab === tab
      ? Number.parseFloat(tabs.style.getPropertyValue("--safari-v8-edit-width"))
      : rect.width;
    const width = Math.max(1, targetWidth || rect.width);
    const left = opening?.tab === tab
      ? (opening.stationaryRight ?? rect.right) - width
      : rect.left;
    urlbar.style.setProperty("--safari-v8-left", `${left}px`);
    urlbar.style.setProperty("--safari-v8-top", `${rect.top + 4}px`);
    urlbar.style.setProperty("--safari-v8-width", `${width}px`);
    urlbar.style.setProperty(
      "--safari-v8-height", `${Math.max(1, rect.height - 8)}px`
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
          // A superseded animation must not remove its replacement.
          if (iconLabelReveals.get(tab) === animations) {
            iconLabelReveals.delete(tab);
          }
        });
    }
  }

  function centerInactiveTabContent(normalTabs, active) {
    const updates = normalTabs.map(tab => {
      let correction = 0;
      if (normalTabs.length > 4 && tab !== active &&
          !tab.classList.contains("safari-v8-icon-only")) {
        const content = tab.querySelector(".tab-content");
        const icon = tab.querySelector(".tab-icon-stack");
        const label = tab.querySelector(".tab-label-container");
        if (content && icon && label) {
          const style = getComputedStyle(content);
          const pixels = value => Number.parseFloat(value) || 0;
          const leading = pixels(style.paddingLeft);
          const trailing = pixels(style.paddingRight);
          const groupWidth = icon.offsetWidth + label.offsetWidth +
            pixels(style.columnGap);
          const freeSpace = Math.max(0,
            content.clientWidth - leading - trailing - groupWidth);
          // Center against the whole content box where possible, but
          // never move the group into the permanent leading close slot.
          correction = -Math.min(
            Math.max(0, (leading - trailing) / 2),
            freeSpace / 2
          );
        }
      }
      return {tab, value: `${correction.toFixed(3)}px`};
    });
    for (const {tab, value} of updates) {
      if (tab.style.getPropertyValue("--safari-v8-content-center") !== value) {
        tab.style.setProperty("--safari-v8-content-center", value);
      }
    }
  }

  function updateNoScrollLayout() {
    // display:none can remove navigation space without a width transition.
    // Follow that state change directly as well as animated reservations.
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
    document.documentElement.classList.toggle(
      "safari-v8-navigation-layout-follow", navigationWidthMoving
    );
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
    // The inherited selected-tab minimum defeats opening at dense counts.
    // Keep this state after opening to avoid restoring the clamp at handoff.
    document.documentElement.classList.toggle(
      "safari-v8-dense-tabs", count >= 9
    );
    const rowWidth = Math.min(available, window.innerWidth * count / 4);
    const active = selectedTab();
    const allocation = noScrollTabAllocation(
      rowWidth, count, normalTabs.includes(active)
    );
    // Selection, not address focus, owns the larger real tab allocation.
    const editingWidth = allocation.selected;

    const setPixels = (name, value) => {
      const next = `${value.toFixed(3)}px`;
      if (tabs.style.getPropertyValue(name) !== next) {
        tabs.style.setProperty(name, next);
      }
    };
    const opening = sharedOpeningGeometry;
    const progress = opening?.progress ?? 1;
    // A shelf already filling its allocation follows navigation geometry
    // directly. Only actual shelf growth uses the opening interpolation.
    const paintedRowWidth = opening && !opening.fullShelf
      ? opening.width + (rowWidth - opening.width) * progress
      : rowWidth;
    setPixels("--safari-v8-row-width", paintedRowWidth);
    setPixels("--safari-v8-edit-width", editingWidth);
    const start = container.left +
      (Number.parseFloat(style.paddingLeft) || 0) + pinnedWidth;
    const targetOffset = Math.max(0, Math.min(available - rowWidth,
      (window.innerWidth - rowWidth) / 2 - start));
    if (opening) {
      // Only append-to-end openings on an already full shelf use a stationary
      // foreground. Growing shelves and middle insertions retain native motion.
      // Eligibility belongs to the opening transaction, not a per-frame
      // comparison against a target changed by navigation-button collapse.
      const stationary = count > 4 &&
        normalTabs.at(-1) === opening.tab &&
        opening.fullShelf;
      opening.stationaryRight = stationary
        ? start + targetOffset + rowWidth
        : null;
    }
    setPixels("--safari-v8-row-offset", opening && !opening.fullShelf
      ? opening.left - start +
        (targetOffset - (opening.left - start)) * progress
      : targetOffset);

    for (const [index, tab] of normalTabs.entries()) {
      const isActive = tab === active;
      for (const [name, value] of [
        ["--safari-v8-tab-width",
          `${(isActive ? allocation.selected : allocation.ordinary).toFixed(3)}px`],
        ["--safari-v8-tab-grow",
          String(isActive ? allocation.selectedGrow : 1)]
      ]) {
        if (tab.style.getPropertyValue(name) !== value) {
          tab.style.setProperty(name, value);
        }
      }
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

    // TabOpen can precede native selection. Do not classify the old
    // selected tab using its temporary selected allocation.
    const presentationOpening = newTabOpening && sharedOpeningGeometry;
    if (presentationOpening && presentationOpening.tab !== active) return;

    const revealOrigins = [];
    const presentationChanges = [];
    // During closing, the final allocation is already known. Start revealing
    // labels as space is released, rather than waiting for the width threshold
    // late in the native transition. Settled compression rules stay unchanged.
    const closingLayout = !newTabOpening && [...gBrowser.tabs].some(tab =>
      tab.closing || tab.classList.contains("safari-v8-retiring")
    );
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    for (const tab of [...iconLabelReveals.keys()]) {
      if (!normalTabs.includes(tab) || tab === active ||
          newTabOpening || draggedControlTab || reduceMotion) {
        cancelIconLabelReveal(tab);
      }
    }

    // Evaluate the text budget, not a fixed outer tab width.
    // Allow a shorter proportional-font prefix before switching to icons.
    // The 2.75em budget includes ellipsis; this is visual calibration,
    // not a measured Safari constant or a fixed character count.
    for (const tab of normalTabs) {
      let iconOnly = false;
      if (tab !== active) {
        const content = tab.querySelector(".tab-content");
        const icon = tab.querySelector(".tab-icon-stack");
        const label = tab.querySelector(".tab-label");
        if (content && icon && label) {
          const style = getComputedStyle(content);
          const font = getComputedStyle(label, "::after");
          const pixels = value => Number.parseFloat(value) || 0;
          // Evaluate labelled-state padding and gap in both states.
          // Centering icon-only content must not change the text threshold
          // or make the presentation oscillate with its own class.
          const gap = Math.max(5.5, pixels(style.columnGap));
          const textBudget = content.getBoundingClientRect().width -
            pixels(style.borderLeftWidth) - pixels(style.borderRightWidth) -
            Math.max(30, pixels(style.paddingLeft)) -
            Math.max(8, pixels(style.paddingRight)) -
            icon.getBoundingClientRect().width - gap;
          const minimumTextBudget = 2.75 * (pixels(font.fontSize) || 13);
          const targetWidth = Number.parseFloat(
            tab.style.getPropertyValue("--safari-v8-tab-width")
          );
          const releasedWidth = closingLayout && Number.isFinite(targetWidth)
            ? Math.max(0, targetWidth - tab.getBoundingClientRect().width)
            : 0;
          // During opening, classify against the assigned endpoint,
          // not transient widths as the former selected tab contracts.
          // Closing retains its separately approved early-reveal behavior.
          const openingWidthDelta = presentationOpening &&
            Number.isFinite(targetWidth)
            ? targetWidth - tab.getBoundingClientRect().width
            : 0;
          iconOnly = textBudget + releasedWidth + openingWidthDelta <
            minimumTextBudget;
        }
      }
      const wasIconOnly = tab.classList.contains("safari-v8-icon-only");
      if (wasIconOnly === iconOnly) continue;
      cancelIconLabelReveal(tab);
      if (wasIconOnly && !iconOnly && tab !== active &&
          !newTabOpening && !draggedControlTab && !reduceMotion) {
        const icon = tab.querySelector(".tab-icon-stack");
        const label = tab.querySelector(".tab-label-container");
        if (icon && label) {
          const iconRect = icon.getBoundingClientRect();
          if (iconRect.width > 0) {
            revealOrigins.push({
              tab, icon, label,
              localLeft: iconRect.left - tab.getBoundingClientRect().left
            });
          }
        }
      }
      presentationChanges.push({tab, iconOnly});
    }
    // Batch class writes after all source measurements.
    for (const {tab, iconOnly} of presentationChanges) {
      tab.classList.toggle("safari-v8-icon-only", iconOnly);
    }
    // Establish final presentation before measuring reveal destinations.
    // Relative positioning is independent of the reveal's animated translate.
    centerInactiveTabContent(normalTabs, active);
    animateIconLabelReveals(revealOrigins);
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
      // Extend the focus handoff's braking without changing tab opening.
      const timing = {
        duration: 220, easing: "cubic-bezier(.16, 1, .3, 1)"
      };
      animateContentHandoff(glyphSlot, delta, timing);
      animateContentHandoff(
        urlbar.querySelector(".urlbar-input-box") || input, delta, timing
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
    if (draggedControlTab) {
      return draggedControlTab.querySelector(".tab-background")
        ?.getBoundingClientRect() ||
        draggedControlTab.getBoundingClientRect();
    }
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

  // Fixed controls follow the dragged tab's painted native transform.
  let draggedControlTab = null;
  let draggedControlFrame = 0;
  let draggedControlEnding = false;
  let draggedControlDeadline = 0;

  function stopDraggedControls() {
    cancelAnimationFrame(draggedControlFrame);
    draggedControlFrame = 0;
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
    const tab = event.target.closest?.(".tabbrowser-tab");
    if (!noScrollLayoutEnabled() || !tab ||
        tab.hidden || tab.closing) return;
    stopDraggedControls();
    draggedControlTab = tab;
    tabCloseTarget = tab;
    const row = document.querySelector("#tabbrowser-arrowscrollbox");
    row?.classList.add("safari-v8-drag-shelf-clip");
    const follow = () => {
      draggedControlFrame = 0;
      const owner = draggedControlTab;
      if (!owner || !owner.isConnected || owner.closing ||
          owner.hidden || (draggedControlEnding &&
          performance.now() >= draggedControlDeadline)) {
        stopDraggedControls();
        return;
      }
      // Root-level fixed controls do not inherit the row's paint clip.
      // Use the same stationary shelf bounds for both control canvases.
      const rect = owner.querySelector(".tab-background")
        ?.getBoundingClientRect() || owner.getBoundingClientRect();
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
      draggedControlFrame = requestAnimationFrame(follow);
    };
    draggedControlFrame = requestAnimationFrame(follow);
  }

  // Native reordering only receives dragover while the pointer targets tabs.
  // Extend below the shelf by three row heights; distant detach stays native.
  function forwardShelfDrag(event) {
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

  function reloadTargetRect() {
    if (draggedControlTab) {
      return draggedControlTab.querySelector(".tab-background")
        ?.getBoundingClientRect() ||
        draggedControlTab.getBoundingClientRect();
    }
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
    if (reloadHover) reloadButton.classList.add("visible");
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
    // Drag ownership must not follow tabs crossed by the pointer.
    if (draggedControlTab) return;
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
      const opening = sharedOpeningGeometry;
      if (newTabOpening && opening) {
        if (opening.tab === selectedTab()) {
          // TabOpen may have painted while the previous tab was selected.
          // Transfer ownership at native selection, not at animation finish.
          if (visible && addressOwner !== opening.tab) setVisible(true);
        } else {
          // A real selection away retires the transaction synchronously.
          // Its queued focus and geometry callbacks must not reclaim paint.
          cancelAnimationFrame(newTabGeometryFrame);
          newTabGeometryFrame = 0;
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

    // Opening motion belongs to shared geometry, not a trailing
    // decorative content animation.
  }

  function waitForStableNewTabGeometry(openedTab, token) {
    cancelAnimationFrame(newTabGeometryFrame);
    if (noScrollLayoutEnabled()) {
      const sample = () => {
        newTabGeometryFrame = 0;
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
        positionAddressSurface();
        positionShelfGeometryProbe();
        if (fadedIn && (!animation || reduced ||
            animation.playState === "finished")) {
          finishStableNewTab(openedTab, token);
          return;
        }
        newTabGeometryFrame = requestAnimationFrame(sample);
      };
      newTabGeometryFrame = requestAnimationFrame(sample);
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


  // Native replenishment normally waits for the opening transition.
  // Refill after the current tab-creation transaction instead, so a rapid
  // second Cmd+T can consume prepared content. Native policy/counts still
  // decide whether a preload may be created.
  function replenishNewTabPreload(openedTab) {
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
    clearIconLabelReveals();
    clearClosingCapsulePaints();
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
    // TabOpen precedes native load/selection initialization. Do not create
    // another browser reentrantly inside that unfinished transaction.
    queueMicrotask(() => replenishNewTabPreload(openedTab));
    const token = ++newTabGeometryToken;
    clearOpeningContentOcclusion();
    sharedOpeningGeometry = null;
    document.documentElement.classList.remove("safari-v8-opening-clock");
    if (noScrollLayoutEnabled() && !openedTab.pinned) {
      const row = document.querySelector("#tabbrowser-arrowscrollbox");
      const rect = row?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        const container = tabs.getBoundingClientRect();
        const style = getComputedStyle(tabs);
        const padding = (Number.parseFloat(style.paddingLeft) || 0) +
          (Number.parseFloat(style.paddingRight) || 0);
        const pinnedWidth = document.querySelector("#pinned-tabs-container")
          ?.getBoundingClientRect().width || 0;
        const available = Math.max(0, container.width - padding - pinnedWidth);
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

    // TabOpen precedes native selection and browser-load initialization.
    // Focus only after that transaction, never on the previous tab or on
    // behalf of an opening superseded by another rapid Cmd+T.
    queueMicrotask(() => {
      if (
        token !== newTabGeometryToken ||
        openedTab !== selectedTab()
      ) return;
      gURLBar.focus();
      gURLBar.select();
      revealSelectedAddressFromStart();
    });

    queueMicrotask(animateNavigationShiftIfNeeded);
    waitForStableNewTabGeometry(openedTab, token);
  }

  // Paint-only closing snapshot. Never retain a live input or native tab.
  const closingCapsulePaints = new Set();

  function clearClosingCapsulePaints() {
    for (const paint of [...closingCapsulePaints]) paint.dispose();
  }

  function preserveClosingCapsule(tab) {
    const ordinary = [...gBrowser.tabs].filter(
      item => !item.hidden && !item.closing && !item.pinned
    );
    if (!noScrollLayoutEnabled() || newTabOpening ||
        tab !== selectedTab() || tab.pinned ||
        ordinary.length < 2 || ordinary.length > 4 ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const source = visible && addressOwner === tab
      ? inputContainer : tab.querySelector(".tab-stack");
    if (!source) return;
    const rect = source.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || tabRect.width <= 0) return;

    // Freeze resolved paint before selection/ownership rules change.
    // No IDs, event attributes, editable controls or accessibility duplicates.
    const freeze = element => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" ||
          Number(style.opacity) === 0) return null;
      const isInput = element === input ||
        element.localName === "input" || element.localName === "textarea";
      const copy = document.createElement(isInput ? "span" : "div");
      for (const property of style) {
        copy.style.setProperty(property, style.getPropertyValue(property), "important");
      }
      copy.style.setProperty("animation", "none", "important");
      copy.style.setProperty("transition", "none", "important");
      copy.style.setProperty("pointer-events", "none", "important");
      if (isInput) {
        copy.textContent = element.value || element.placeholder || "";
        copy.style.setProperty("white-space", "nowrap", "important");
        copy.style.setProperty("overflow", "hidden", "important");
        if (!element.value) {
          const placeholder = getComputedStyle(element, "::placeholder");
          copy.style.setProperty("color", placeholder.color, "important");
          copy.style.setProperty("opacity", placeholder.opacity, "important");
        }
      } else {
        for (const child of element.childNodes) {
          if (child.nodeType === 3) {
            copy.appendChild(document.createTextNode(child.textContent));
          } else if (child.nodeType === 1) {
            const frozen = freeze(child);
            if (frozen) copy.appendChild(frozen);
          }
        }
      }
      return copy;
    };
    const snapshot = freeze(source);
    if (!snapshot) return;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.inert = true;
    host.style.cssText = `
      position:fixed!important;left:${rect.left}px!important;
      top:${rect.top}px!important;width:${rect.width}px!important;
      height:${rect.height}px!important;overflow:clip!important;
      border-radius:15px!important;pointer-events:none!important;
      z-index:2147482999!important;`;
    snapshot.style.setProperty("position", "absolute", "important");
    snapshot.style.setProperty("inset", "0 auto auto 0", "important");
    snapshot.style.setProperty("margin", "0", "important");
    snapshot.style.setProperty("width", `${rect.width}px`, "important");
    snapshot.style.setProperty("height", `${rect.height}px`, "important");
    snapshot.style.setProperty("min-width", "0", "important");
    snapshot.style.setProperty("max-width", "none", "important");
    host.appendChild(snapshot);
    document.documentElement.appendChild(host);

    let frameId = 0;
    let disposed = false;
    const fade = host.animate(
      [{opacity: 1}, {opacity: .85, offset: .35}, {opacity: 0}],
      {duration: 300, easing: "ease-in-out", fill: "forwards"}
    );
    const paint = {
      dispose() {
        if (disposed) return;
        disposed = true;
        cancelAnimationFrame(frameId);
        fade.cancel();
        host.remove();
        closingCapsulePaints.delete(paint);
      }
    };
    closingCapsulePaints.add(paint);
    const follow = () => {
      if (disposed) return;
      if (!tab.isConnected) {
        paint.dispose();
        return;
      }
      const current = tab.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, current.width / tabRect.width));
      host.style.setProperty("left",
        `${rect.left + current.left - tabRect.left}px`, "important");
      host.style.setProperty("top",
        `${rect.top + current.top - tabRect.top}px`, "important");
      host.style.setProperty("width", `${rect.width * ratio}px`, "important");
      frameId = requestAnimationFrame(follow);
    };
    frameId = requestAnimationFrame(follow);
    fade.finished.then(() => paint.dispose(), () => paint.dispose());
  }

  function onTabClose(event) {
    if (!noScrollLayoutEnabled()) return;
    cancelIconLabelReveal(event.target);
    preserveClosingCapsule(event.target);
    // Retire the opening transaction before close callbacks can reuse its
    // partial row allocation. A stale RAF must not finish a closing tab.
    if (sharedOpeningGeometry?.tab === event.target) {
      cancelAnimationFrame(newTabGeometryFrame);
      newTabGeometryFrame = 0;
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
      positionAddressSurface();
    }
    // TabClose precedes the native closing flag on some Firefox versions.
    // Defer allocation to the event's completed native state, not a timer.
    queueMicrotask(() => {
      updateNoScrollLayout();
      positionUrlbar();
      positionAddressSurface();
      positionShelfGeometryProbe();
      // Follow the complete 300ms close transition, including its tail.
      followShelfGeometryAnimation(340);
    });
  }

  const layoutEvents = ["TabClose", "TabMove", "TabPinned", "TabUnpinned"];

  urlbar.classList.add("safari-v8-moving");
  tabs.addEventListener("pointerdown", onTabPointerDown, true);
  if (typeof originalStartTabDrag === "function") {
    nativeDragOwner.startTabDrag = startTabDragWithLoneTabImage;
  }
  if (typeof originalCheckPinnedBounds === "function") {
    nativeDragOwner._checkWithinPinnedContainerBounds =
      checkPinnedBoundsWithoutCompactCue;
  }
  tabs.addEventListener("dragstart", startDraggedControls, true);
  window.addEventListener("dragover", forwardShelfDrag, true);
  window.addEventListener("drop", forwardShelfDrag, true);
  window.addEventListener("dragend", finishDraggedControls, true);
  window.addEventListener("drop", finishDraggedControls, true);
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
    clearIconLabelReveals();
    stopDraggedControls();
    tabs.removeEventListener("dragstart", startDraggedControls, true);
    if (nativeDragOwner?.startTabDrag === startTabDragWithLoneTabImage) {
      nativeDragOwner.startTabDrag = originalStartTabDrag;
    }
    if (nativeDragOwner?._checkWithinPinnedContainerBounds ===
        checkPinnedBoundsWithoutCompactCue) {
      nativeDragOwner._checkWithinPinnedContainerBounds =
        originalCheckPinnedBounds;
    }
    window.removeEventListener("dragover", forwardShelfDrag, true);
    window.removeEventListener("drop", forwardShelfDrag, true);
    window.removeEventListener("dragend", finishDraggedControls, true);
    window.removeEventListener("drop", finishDraggedControls, true);
    clearClosingCapsulePaints();
    clearOpeningContentOcclusion();
    sharedOpeningGeometry = null;
    document.documentElement.classList.remove("safari-v8-opening-clock");
    noScrollShadowStyle?.remove();
    noScrollShadowStyle = null;
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
})();
