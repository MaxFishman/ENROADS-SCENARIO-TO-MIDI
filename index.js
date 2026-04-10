'use strict';

/**
 * index.js – EN-ROADS ↔ MIDI Bridge
 *
 * Launches a Puppeteer-controlled Chromium window pointing at the EN-ROADS
 * climate simulator.  Every range-input slider found on the page is assigned
 * a unique MIDI CC number starting at config.ccOffset.
 *
 * Data flow
 * ---------
 *   Slider moved by user  →  MIDI CC message sent to the configured output port
 *   MIDI CC message received  →  corresponding slider moved in realtime
 *
 * Scaling
 * -------
 *   slider value  →  MIDI  :  round( (value - min) / (max - min) * 127 )
 *   MIDI  →  slider value  :  min + (midiValue / 127) * (max - min),
 *                              snapped to the nearest step
 */

const puppeteer = require('puppeteer');
const midi = require('@julusian/midi');
const config = require('./config');

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {import('puppeteer').Page} */
let page = null;

/** @type {import('@julusian/midi').Output} */
let midiOutput = null;

/** @type {import('@julusian/midi').Input} */
let midiInput = null;

/**
 * Slider metadata collected from the page.
 * @type {Array<{index:number, label:string, min:number, max:number, step:number, value:number}>}
 */
let sliders = [];

/** cc  → slider index */
const ccToIndex = new Map();

/** slider index  → cc */
const indexToCc = new Map();

/**
 * Guard flag: set to true while we are programmatically moving a slider so
 * that the slider's input-event listener does not re-fire a MIDI message and
 * create a feedback loop.
 */
let updatingFromMidi = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a slider's native value into the MIDI range 0–127.
 *
 * @param {number} value  Current slider value.
 * @param {number} min    Slider minimum.
 * @param {number} max    Slider maximum.
 * @returns {number}  Integer in [0, 127].
 */
function valueToMidi(value, min, max) {
  if (max === min) return 0;
  const normalized = (value - min) / (max - min);
  return Math.round(Math.min(127, Math.max(0, normalized * 127)));
}

/**
 * Map a MIDI CC value (0–127) back to the slider's native range, snapping to
 * the nearest step.
 *
 * @param {number} midiValue  MIDI value in [0, 127].
 * @param {number} min        Slider minimum.
 * @param {number} max        Slider maximum.
 * @param {number} step       Slider step size (0 means no snapping).
 * @returns {number}  Value in the slider's native range.
 */
function midiToValue(midiValue, min, max, step) {
  const normalized = midiValue / 127;
  const raw = min + normalized * (max - min);
  if (step && step > 0) {
    return Math.round(raw / step) * step;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Slider discovery
// ---------------------------------------------------------------------------

/**
 * Query every <input type="range"> on the page and return an array of slider
 * descriptors.  This runs inside the browser context via page.evaluate().
 *
 * @returns {Promise<Array<{index, label, min, max, step, value}>>}
 */
async function discoverSliders() {
  return page.evaluate(() => {
    /**
     * Best-effort: try to find a human-readable label for the given input
     * element by walking the DOM.
     */
    function findLabel(input, index) {
      // 1. aria-label attribute
      const ariaLabel = input.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();

      // 2. <label for="id">
      if (input.id) {
        const labelEl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (labelEl && labelEl.textContent.trim()) {
          return labelEl.textContent.trim();
        }
      }

      // 3. Closest ancestor that contains a label-like element
      let ancestor = input.parentElement;
      for (let depth = 0; depth < 5 && ancestor; depth++) {
        // Look for an explicit <label>, or elements with label-like classes
        const candidates = ancestor.querySelectorAll(
          'label, [class*="label"], [class*="Label"], [data-label]'
        );
        for (const c of candidates) {
          const text = c.textContent.trim();
          if (text && text.length < 80) return text;
        }
        ancestor = ancestor.parentElement;
      }

      // 4. name / id as last resort
      return input.name || input.id || `Slider ${index + 1}`;
    }

    const inputs = Array.from(document.querySelectorAll('input[type="range"]'));
    return inputs.map((input, index) => ({
      index,
      label: findLabel(input, index),
      min: parseFloat(input.min !== '' ? input.min : 0),
      max: parseFloat(input.max !== '' ? input.max : 100),
      step: parseFloat(input.step !== '' ? input.step : 1) || 0,
      value: parseFloat(input.value !== '' ? input.value : 0),
    }));
  });
}

// ---------------------------------------------------------------------------
// Browser-side slider monitoring
// ---------------------------------------------------------------------------

/**
 * Inject event listeners into the page that call back into Node.js whenever a
 * slider value changes (via the `onSliderChange` function exposed by
 * page.exposeFunction).
 */
async function injectSliderListeners() {
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="range"]'));
    inputs.forEach((input, index) => {
      // Use 'input' for live tracking while dragging; 'change' for final value
      const handler = (e) => window.__onSliderChange(index, parseFloat(e.target.value));
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    });
  });
}

// ---------------------------------------------------------------------------
// MIDI setup
// ---------------------------------------------------------------------------

/**
 * Open (or create) a MIDI output port.
 *
 * @returns {import('@julusian/midi').Output}
 */
function openMidiOutput() {
  const output = new midi.Output();
  const portCount = output.getPortCount();

  if (config.midiOutputName) {
    for (let i = 0; i < portCount; i++) {
      if (output.getPortName(i) === config.midiOutputName) {
        output.openPort(i);
        console.log(`[MIDI OUT] Connected to port: "${config.midiOutputName}"`);
        return output;
      }
    }
    console.warn(`[MIDI OUT] Port "${config.midiOutputName}" not found. Available ports:`);
    for (let i = 0; i < portCount; i++) {
      console.warn(`  ${i}: ${output.getPortName(i)}`);
    }
  }

  if (portCount > 0) {
    output.openPort(0);
    console.log(`[MIDI OUT] Connected to port 0: "${output.getPortName(0)}"`);
    return output;
  }

  // No hardware ports – create a virtual port so DAWs can connect to it
  output.openVirtualPort('ENROADS OUT');
  console.log('[MIDI OUT] Created virtual port: "ENROADS OUT"');
  return output;
}

/**
 * Open (or create) a MIDI input port and attach the CC listener.
 *
 * @returns {import('@julusian/midi').Input}
 */
function openMidiInput() {
  const input = new midi.Input();

  // Ignore SysEx, timing, and active sensing by default
  input.ignoreTypes(true, true, true);

  const portCount = input.getPortCount();

  if (config.midiInputName) {
    for (let i = 0; i < portCount; i++) {
      if (input.getPortName(i) === config.midiInputName) {
        input.openPort(i);
        console.log(`[MIDI IN]  Connected to port: "${config.midiInputName}"`);
        attachMidiListener(input);
        return input;
      }
    }
    console.warn(`[MIDI IN]  Port "${config.midiInputName}" not found. Available ports:`);
    for (let i = 0; i < portCount; i++) {
      console.warn(`  ${i}: ${input.getPortName(i)}`);
    }
  }

  if (portCount > 0) {
    input.openPort(0);
    console.log(`[MIDI IN]  Connected to port 0: "${input.getPortName(0)}"`);
    attachMidiListener(input);
    return input;
  }

  // No hardware ports – create a virtual port
  input.openVirtualPort('ENROADS IN');
  console.log('[MIDI IN]  Created virtual port: "ENROADS IN"');
  attachMidiListener(input);
  return input;
}

/**
 * Attach the raw MIDI message listener to an already-opened input port.
 *
 * @param {import('@julusian/midi').Input} input
 */
function attachMidiListener(input) {
  input.on('message', async (_deltaTime, message) => {
    // message is a Buffer / Uint8Array: [status, data1, data2]
    const [status, controller, value] = message;
    const messageType = status & 0xf0;
    const channel = status & 0x0f;

    // Only handle Control Change on the configured channel
    if (messageType !== 0xb0) return;
    if (channel !== config.midiChannel) return;

    const sliderIndex = ccToIndex.get(controller);
    if (sliderIndex === undefined) return;

    const slider = sliders[sliderIndex];
    if (!slider) return;

    const sliderValue = midiToValue(value, slider.min, slider.max, slider.step);
    console.log(
      `[MIDI IN]  CC${controller} = ${value}  →  ` +
        `"${slider.label}" = ${sliderValue.toFixed(3)}`
    );

    updatingFromMidi = true;
    try {
      await setSliderValue(sliderIndex, sliderValue);
    } finally {
      updatingFromMidi = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Moving a slider from Node.js
// ---------------------------------------------------------------------------

/**
 * Set the value of a range input at position `sliderIndex` in the NodeList
 * returned by `querySelectorAll('input[type="range"]')`.
 *
 * We must use the native property setter to bypass React/Angular's synthetic
 * event system, otherwise React will discard the change.
 *
 * @param {number} sliderIndex  Zero-based position in the NodeList.
 * @param {number} value        New value (in the slider's native units).
 */
async function setSliderValue(sliderIndex, value) {
  await page.evaluate(
    (idx, val) => {
      const inputs = document.querySelectorAll('input[type="range"]');
      const input = inputs[idx];
      if (!input) return;

      // Use the native setter to bypass React / Angular value tracking
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      ).set;
      nativeSetter.call(input, String(val));

      // Dispatch both events so the framework and any plain-JS listeners both fire.
      // InputEvent (rather than plain Event) is required for React-based apps like
      // EN-ROADS to recognise the change as genuine user input and update dependent
      // state (e.g. graphs in the split/mixing-desk view).
      input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    sliderIndex,
    value
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('EN-ROADS ↔ MIDI Bridge starting…');
  console.log(`URL       : ${config.enroadsUrl}`);
  console.log(`Channel   : ${config.midiChannel + 1}`);
  console.log(`CC offset : ${config.ccOffset}`);
  console.log(`Headless  : ${config.headless}`);
  console.log('');

  // ------------------------------------------------------------------
  // 1. Open MIDI ports BEFORE the browser so the virtual ports exist
  //    when Ableton / any DAW scans for devices.
  // ------------------------------------------------------------------
  try {
    midiOutput = openMidiOutput();
  } catch (err) {
    console.warn('[MIDI OUT] Could not open output port:', err.message);
  }

  try {
    midiInput = openMidiInput();
  } catch (err) {
    console.warn('[MIDI IN]  Could not open input port:', err.message);
  }

  // ------------------------------------------------------------------
  // 2. Launch browser
  // ------------------------------------------------------------------
  const browser = await puppeteer.launch({
    headless: config.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  console.log('Loading EN-ROADS…');
  await page.goto(config.enroadsUrl, {
    waitUntil: 'networkidle2',
    timeout: config.pageLoadTimeout,
  });

  // Wait until at least one slider is present in the DOM
  await page.waitForSelector('input[type="range"]', {
    timeout: config.sliderWaitTimeout,
  });

  // Give dynamic frameworks a moment to finish rendering
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // ------------------------------------------------------------------
  // 3. Discover sliders and assign CC numbers
  // ------------------------------------------------------------------
  sliders = await discoverSliders();
  console.log(`\nFound ${sliders.length} slider(s):\n`);

  sliders.forEach((s, i) => {
    const cc = config.ccOffset + i;
    indexToCc.set(i, cc);
    ccToIndex.set(cc, i);
    console.log(
      `  CC${String(cc).padStart(3)}  "${s.label}"` +
        `  [${s.min} – ${s.max}, step ${s.step}]  current: ${s.value}`
    );
  });

  console.log('');

  // ------------------------------------------------------------------
  // 4. Expose the Node.js callback and inject browser-side listeners
  // ------------------------------------------------------------------
  await page.exposeFunction('__onSliderChange', (index, value) => {
    if (updatingFromMidi) return; // Prevent feedback loop

    const slider = sliders[index];
    if (!slider) return;

    // Keep our in-memory copy in sync
    slider.value = value;

    const cc = indexToCc.get(index);
    if (cc === undefined) return;

    const midiValue = valueToMidi(value, slider.min, slider.max);

    console.log(
      `[SLIDER]   "${slider.label}" = ${value}  →  CC${cc} = ${midiValue}`
    );

    if (midiOutput) {
      // Control Change: [0xB0 | channel, controller, value]
      midiOutput.sendMessage([0xb0 | config.midiChannel, cc, midiValue]);
    }
  });

  await injectSliderListeners();

  // ------------------------------------------------------------------
  // 5. Re-inject listeners if the SPA does a full navigation/re-render
  // ------------------------------------------------------------------
  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      await page.waitForSelector('input[type="range"]', { timeout: 10000 });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      sliders = await discoverSliders();
      await injectSliderListeners();
      console.log(`[PAGE]     Re-injected listeners after navigation (${sliders.length} sliders)`);
    } catch {
      // Page may have navigated away intentionally
    }
  });

  // ------------------------------------------------------------------
  // 6. Graceful shutdown
  // ------------------------------------------------------------------
  const shutdown = () => {
    console.log('\nShutting down…');
    if (midiOutput) midiOutput.closePort();
    if (midiInput) midiInput.closePort();
    browser.close().finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  browser.on('disconnected', () => {
    console.log('[PAGE]     Browser disconnected.');
    shutdown();
  });

  console.log('Bridge is running.');
  console.log('→ Move sliders in EN-ROADS to send MIDI CC messages to your DAW.');
  console.log('→ Send MIDI CC messages from your DAW to move EN-ROADS sliders in realtime.');
  console.log('   Press Ctrl+C to exit.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
