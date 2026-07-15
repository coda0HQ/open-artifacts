Feature: Build validation catches silent layout defects

  As an agent authoring an artifact
  I want the build to fail when a CSS container class is defined but never applied
  So that content never ships spanning 100% of the viewport because the measure
  cap referenced a class the markup forgot to use

  Scenario: A container class defined in CSS but absent from the body fails validation
    Given an HTML recipe whose theme or styles define a class with a measure constraint
      (max-width) but the body fragment never applies that class
    When the agent runs the artifact script with validate
    Then the build fails with a message naming the unapplied container class
    And no publish request is made

  Scenario: A container class that the body actually applies passes validation
    Given an HTML recipe whose styles define .report with a max-width and the body
      wraps its content in <main class="report">
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: A max-width class applied only via JS passes validation
    Given an HTML recipe at level 2 whose styles define .dur-bar with a max-width but
      the body fragment never applies it statically — the script injects the class at runtime
    When the agent runs the artifact script with validate
    Then the build succeeds because a class referenced as a quoted string in a script counts as applied

  Scenario: A max-width class defined but never applied even in scripts fails validation
    Given an HTML recipe at level 2 whose styles define .shell with a max-width but neither
      the body fragment nor any script references .shell
    When the agent runs the artifact script with validate
    Then the build fails with a message naming the unapplied container class
    And no publish request is made

  Scenario: A bare body element used as the container passes validation
    Given an HTML recipe whose styles set max-width on body itself rather than a class
    When the agent runs the artifact script with validate
    Then the build succeeds because the constraint lives on an element, not a class

  Scenario: A level 1 non-canvas HTML page with no measure cap fails validation
    Given an HTML recipe at level 1 that defines no max-width anywhere in its
      theme or styles and does not use the .oa-prose baseline
    When the agent runs the artifact script with validate
    Then the build fails with a message pointing the author to the .oa-prose baseline
      or a measure cap on body
    And no publish request is made

  Scenario: A level 1 page using the .oa-prose baseline passes validation
    Given an HTML recipe at level 1 whose body wraps content in main.oa-prose
    When the agent runs the artifact script with validate
    Then the build succeeds because the .oa-prose baseline supplies the measure cap

  Scenario: A level 2 or 3 page with no measure cap passes validation
    Given an HTML recipe at level 2 that defines no max-width anywhere
    When the agent runs the artifact script with validate
    Then the build succeeds because the measure-cap guard only applies to level 1

  Scenario: A start tag carrying style= twice fails validation
    Given an HTML recipe whose body fragment authors a single start tag with two
      style attributes, so the second value is silently dropped by the HTML parser
    When the agent runs the artifact script with validate
    Then the build fails with a message telling the author to merge both into one style attribute
    And no publish request is made

  Scenario: A start tag with a single style attribute passes validation
    Given an HTML recipe whose body fragment uses one style attribute per element
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: A CSP-forbidden token appearing only inside a comment passes validation
    Given an HTML recipe whose script fragment mentions a CSP-forbidden API like fetch()
      solely in a comment, with no real call in executable code
    When the agent runs the artifact script with validate
    Then the build succeeds because comments are not executable

  Scenario: A real CSP-forbidden call in executable code fails validation
    Given an HTML recipe whose body fragment calls a forbidden API in executable code
    When the agent runs the artifact script with validate
    Then the build fails naming the forbidden API as incompatible with the CSP
    And no publish request is made

  Scenario: A Markdown recipe without a document.theme field passes validation
    Given a Markdown recipe that omits document.theme entirely
    When the agent runs the artifact script with validate
    Then the build succeeds because document.theme is an optional label with no runtime effect

  Scenario: An authored dark --muted below 4.5:1 contrast fails validation
    Given an HTML recipe whose dark theme block overrides --muted to a color whose contrast
      against --bg falls under 4.5:1
    When the agent runs the artifact script with validate
    Then the build fails naming the failing pair and its ratio and the 4.5:1 minimum
    And no publish request is made

  Scenario: An authored dark --muted at or above 4.5:1 contrast passes validation
    Given an HTML recipe whose dark theme block overrides --muted to a sufficiently light gray
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: Migrating a legacy bare-L1 page wraps it in the prose baseline
    Given a legacy level 1 non-canvas artifact whose published content has identity
      tokens but no measure cap and no .oa-prose wrapper
    When the agent runs the artifact script with update to migrate it to a Recipe
    Then the build succeeds because migration wraps the body in main.oa-prose
    And the migrated body fragment contains class="oa-prose"
    And the artifact is not locked out of future updates

  Scenario: An artifact with no scrollspy passes validation untouched
    Given an HTML recipe whose script wires a click handler and never references aria-current,
      an IntersectionObserver on nav sections, or a scroll listener toggling active classes by section id
    When the agent runs the artifact script with validate
    Then the build succeeds and no scrollspy-related message is emitted

  Scenario: A scrollspy with a tight IO band, no bottom-boundary fallback, and scrollIntoView in setActive fails validation
    Given an HTML recipe whose script builds a scrollspy — an IntersectionObserver with a tight bottom rootMargin
      observing a sections collection, with setActive toggling aria-current and calling scrollIntoView, and no boundary expression
    When the agent runs the artifact script with validate
    Then the build fails naming the bottom-boundary fallback as the preferred fix and the scrollIntoView self-interference
    And no publish request is made

  Scenario: A scrollspy with a bottom-boundary fallback and chip-only scrollIntoView passes validation
    Given an HTML recipe whose script builds a scrollspy with a recompute that reads scrollY and scrollHeight
      to activate the last section at scroll end, and scrollIntoView only in a separate sync function
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: A lazy-image-reveal artifact (not a scrollspy) passes validation untouched
    Given an HTML recipe whose script reveals images on viewport entry via IntersectionObserver and toggles is-active,
      with no sections collection observed and no aria-current
    When the agent runs the artifact script with validate
    Then the build succeeds and no scrollspy-related message is emitted

  Scenario: Two canvas frames with a 0 world-px gap fail validation
    Given a canvas recipe with two frames stacked at 0 gap on the Y axis
    When the agent runs the artifact script with validate
    Then the build fails naming both frames, the gap, and the minimum 24 world-px
    And no publish request is made

  Scenario: Two canvas frames with an 24 world-px gap pass validation
    Given a canvas recipe with two frames stacked with a 24 world-px vertical seam
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: Two canvas frames touching only at a corner pass validation
    Given a canvas recipe with two frames sharing no axis overlap (corner-touch only)
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: A canvas bounding rect under the width+height caps passes validation
    Given a canvas recipe whose frames span under 2880 world px wide and 2560 tall
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: A canvas bounding rect wider than 2880 world px fails validation
    Given a canvas recipe with five 1440-wide frames in a row (~7680 wide)
    When the agent runs the artifact script with validate
    Then the build fails naming the bounding width and the 2880 cap
    And no publish request is made

  Scenario: A canvas bounding rect taller than 2560 world px fails validation
    Given a canvas recipe with frames stacked in a single column taller than 2560
    When the agent runs the artifact script with validate
    Then the build fails naming the bounding height and the 2560 cap

  Scenario: A .oa-note whose collapsed-chip center lands inside a frame fails validation
    Given a canvas recipe with a .oa-note whose --x/--y (chip center) is inside a frame rect
    When the agent runs the artifact script with validate
    Then the build fails naming the note position and the overlapped frame id
    And no publish request is made

  Scenario: A .oa-note in a gutter passes validation
    Given a canvas recipe with a .oa-note whose chip center is in a gutter between frames
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: A decorative side-stripe border-left > 1px fails validation
    Given an HTML recipe whose styles define a border-left:3px accent on a card class
    When the agent runs the artifact script with validate
    Then the build fails naming the side-stripe trope and the offending selector
    And no publish request is made

  Scenario: A blockquote quote-bar border-left passes validation
    Given an HTML recipe whose styles define border-left:3px on a blockquote selector
    When the agent runs the artifact script with validate
    Then the build succeeds because a quote bar is not a decorative accent

  Scenario: A gradient-text combo fails validation
    Given an HTML recipe whose styles combine background-clip:text with a linear-gradient
    When the agent runs the artifact script with validate
    Then the build fails naming the gradient-text trope

  Scenario: A decorative backdrop-filter fails validation
    Given an HTML recipe whose styles use backdrop-filter on a card (not a floating bar)
    When the agent runs the artifact script with validate
    Then the build fails naming the glassmorphism trope

  Scenario: A sanctioned floating bar backdrop-filter passes validation
    Given an HTML recipe whose styles use backdrop-filter on a position:sticky toolbar
    When the agent runs the artifact script with validate
    Then the build succeeds because a floating bar over scrolling content is sanctioned

  Scenario: An enlarged callout box at --text-lg fails validation
    Given an HTML recipe whose styles set font-size:var(--text-lg) on a .positioning callout
    When the agent runs the artifact script with validate
    Then the build fails naming the enlarged-callout trope and the offending selector
    And no publish request is made

  Scenario: A callout box kept at --text-base passes validation
    Given an HTML recipe whose styles set font-size:var(--text-base) on a .positioning callout
    When the agent runs the artifact script with validate
    Then the build succeeds because a callout stays at body scale

  Scenario: A --text-lg lead on a standfirst passes validation
    Given an HTML recipe whose styles set font-size:var(--text-lg) on a .standfirst lead
    When the agent runs the artifact script with validate
    Then the build succeeds because leads and standfirsts are sanctioned large-type surfaces

  Scenario: A heading with an inline icon but no centered-row layout fails validation
    Given an HTML recipe whose body puts an inline <svg> in an <h2> that has neither
      the .oa-ico-text helper nor an authored display:flex/grid rule targeting it
    When the agent runs the artifact script with validate
    Then the build fails naming the crooked-icon defect and pointing to the .oa-ico-text helper
    And no publish request is made

  Scenario: A heading whose icon uses the .oa-ico-text helper passes validation
    Given an HTML recipe whose body wraps an <h2>'s icon and label in class="oa-ico-text"
    When the agent runs the artifact script with validate
    Then the build succeeds because the helper lays the icon and text out as a centered row

  Scenario: A heading centered by an authored flex rule passes validation
    Given an HTML recipe whose styles set display:flex; align-items:center on the section
      heading selector and whose body puts an inline <svg> in that heading
    When the agent runs the artifact script with validate
    Then the build succeeds because the authored flex rule centers the icon with the text

  Scenario: A heading with no icon is untouched by the icon-alignment gate
    Given an HTML recipe whose headings contain only text and no inline <svg>
    When the agent runs the artifact script with validate
    Then the build succeeds and no icon-alignment message is emitted

  Scenario: A heading whose flex rule omits align-items:center fails validation
    Given an HTML recipe whose body puts an inline <svg> in an <h2> whose only layout
      rule is display:flex with no centered cross-axis alignment
    When the agent runs the artifact script with validate
    Then the build fails because a stretched flex row still drops the icon off the midline

  Scenario: A heading centered by a flex rule nested in a media query passes validation
    Given an HTML recipe whose only centered-flex rule for the icon heading is declared
      inside an @media block
    When the agent runs the artifact script with validate
    Then the build succeeds because the gate reads flex rules at any nesting depth

  Scenario: A heading whose icon and label sit in an inner centered-flex span passes validation
    Given an HTML recipe whose body keeps the <h2> block-level and wraps the icon and its
      label in an inner span carrying a display:flex; align-items:center rule
    When the agent runs the artifact script with validate
    Then the build succeeds because an inner centered-row wrapper aligns the icon

  Scenario: An icon-only heading with no adjacent text passes validation
    Given an HTML recipe whose <h2> contains only an inline <svg> mark and no text
    When the agent runs the artifact script with validate
    Then the build succeeds because there is no adjacent text for the icon to be crooked against

  Scenario: Icon-in-heading markup inside an HTML comment passes validation
    Given an HTML recipe whose body shows icon-in-heading markup only inside an HTML comment
    When the agent runs the artifact script with validate
    Then the build succeeds because comments are stripped before the heading scan
