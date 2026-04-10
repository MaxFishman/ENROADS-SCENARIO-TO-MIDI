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
 *   GRAPH_CC_OFFSET    – First CC number assigned to graph output metrics.
 *                        Default: 100 (leaves room for up to 99 slider CCs).
 *   GRAPH_POLL_INTERVAL – How often (ms) to poll graph output values. Default: 500.
 *   HEADLESS           – Run Chromium headless ("true"/"false"). Default: false.
 *   ENROADS_URL        – Full URL to load. Defaults to v26.3.0.
 */

/**
 * Output graph metrics to monitor in EN-ROADS.
 *
 * Each entry describes one output chart:
 *   name     – Human-readable label (printed in the console mapping table).
 *   selector – CSS selector for the DOM element whose trimmed textContent
 *              contains the current numeric value (may include a unit suffix
 *              such as "°C" or "ppm" – non-numeric characters are stripped).
 *   min      – Minimum expected value (maps to MIDI 0).
 *   max      – Maximum expected value (maps to MIDI 127).
 *
 * The selectors below target the key-output value badges that EN-ROADS v26
 * renders in the scoreboard area at the top of the page.  Adjust them if
 * the page structure changes in a newer version.
 */
const defaultGraphMetrics = [
  {
    name: 'Temperature (°C)',
    selector: '[data-testid="temperature-output"], .temperature-value, [class*="tempOutput"]',
    min: 1.0,
    max: 5.0,
  },
  {
    name: 'CO₂ concentration (ppm)',
    selector: '[data-testid="co2-output"], .co2-value, [class*="co2Output"]',
    min: 400,
    max: 1000,
  },
  {
    name: 'Sea level rise (cm)',
    selector: '[data-testid="sea-level-output"], .sea-level-value, [class*="seaLevelOutput"]',
    min: 0,
    max: 100,
  },
];

module.exports = {
  midiOutputName: process.env.MIDI_OUTPUT_NAME || '',
  midiInputName: process.env.MIDI_INPUT_NAME || '',
  /** 0-indexed MIDI channel (0 = channel 1 in most DAWs). */
  midiChannel: Math.max(0, Math.min(15, (parseInt(process.env.MIDI_CHANNEL, 10) || 1) - 1)),
  /** First CC number assigned to the first discovered slider. */
  ccOffset: parseInt(process.env.CC_OFFSET, 10) || 1,
  /** First CC number assigned to the first graph output metric. */
  graphCcOffset: parseInt(process.env.GRAPH_CC_OFFSET, 10) || 100,
  /** Milliseconds between consecutive polls of graph output values. */
  graphPollInterval: parseInt(process.env.GRAPH_POLL_INTERVAL, 10) || 500,
  /** Output graph metrics to monitor (name, selector, min, max). */
  graphMetrics: defaultGraphMetrics,
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
};
