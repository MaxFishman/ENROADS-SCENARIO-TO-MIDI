'use strict';

/**
 * config.js – Runtime configuration for the EN-ROADS → MIDI bridge.
 *
 * All values can be overridden with environment variables:
 *
 *   MIDI_OUTPUT_NAME   – Exact name of the MIDI output port to use.
 *                        If empty the first available port (or a virtual
 *                        port called "ENROADS OUT") is used.
 *   MIDI_INPUT_NAME    – Exact name of the MIDI input port to use.
 *                        If empty the first available port (or a virtual
 *                        port called "ENROADS IN") is used.
 *   MIDI_CHANNEL       – MIDI channel (1–16). Default: 1.
 *   CC_OFFSET          – First CC number assigned to sliders. Default: 1.
 *   HEADLESS           – Run Chromium headless ("true"/"false"). Default: false.
 *   ENROADS_URL        – Full URL to load. Defaults to v26.3.0.
 *   LABEL_OVERRIDES_FILE – Path to a JSON file that maps original slider/graph
 *                          labels (or "cc:<N>" keys) to custom display names.
 *                          Defaults to "labels.json" in the working directory
 *                          if that file exists; set to "" to disable.
 */

module.exports = {
  midiOutputName: process.env.MIDI_OUTPUT_NAME || '',
  midiInputName: process.env.MIDI_INPUT_NAME || '',
  /** 0-indexed MIDI channel (0 = channel 1 in most DAWs). */
  midiChannel: Math.max(0, Math.min(15, (parseInt(process.env.MIDI_CHANNEL, 10) || 1) - 1)),
  /** First CC number assigned to the first discovered slider. */
  ccOffset: parseInt(process.env.CC_OFFSET, 10) || 1,
  /** Run browser without a visible window (useful for headless servers). */
  headless: process.env.HEADLESS === 'true',
  /** EN-ROADS URL to load. */
  enroadsUrl:
    process.env.ENROADS_URL ||
    'https://en-roads.climateinteractive.org/scenario.html?v=26.3.0',
  /** Milliseconds to wait for the page to settle after navigation. */
  pageLoadTimeout: 60000,
  /** Milliseconds to wait for at least one slider to appear after page load. */
  sliderWaitTimeout: 30000,
  /**
   * Path to a JSON file of label overrides.
   * Keys: original label string  OR  "cc:<N>" (e.g. "cc:1").
   * Values: replacement display name.
   * Defaults to "labels.json" in the current working directory when that file
   * exists; set LABEL_OVERRIDES_FILE="" to disable auto-loading.
   */
  labelOverridesFile: process.env.LABEL_OVERRIDES_FILE !== undefined
    ? process.env.LABEL_OVERRIDES_FILE
    : 'labels.json',
  /**
   * Port for the built-in HTTP admin UI.
   * Set HTTP_PORT=0 to disable the server entirely.
   * Default: 3000.
   */
  httpPort: process.env.HTTP_PORT !== undefined
    ? parseInt(process.env.HTTP_PORT, 10)
    : 3000,
};
