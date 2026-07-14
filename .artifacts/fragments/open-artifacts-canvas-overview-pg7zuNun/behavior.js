/* Canvas runtime JS is vendored verbatim from references/canvas.md by the
   builder — do not copy it here. This fragment holds frame-internal
   interactions only, which run inside frame bodies once a frame is focused
   (inert is toggled by the vendored runtime). State stays in memory. */

/* This Level 3 canvas has no in-frame operable widgets that need JS wiring:
   the frames are reference panels (tables, steps, gates), not prototypes.
   The canvas itself (pan/zoom/tour/spotlight/deep-link) is fully handled by
   the vendored runtime, which the builder injects after this script. */
