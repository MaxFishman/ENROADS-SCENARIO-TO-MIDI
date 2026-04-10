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
const fs = require('fs');
const http = require('http');
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
// Label overrides (user-defined rename map)
// ---------------------------------------------------------------------------

/**
 * Load the label-override map from the file path given in config.
 * Returns an empty object when the file is absent or empty.
 *
 * File format – a plain JSON object whose keys are either:
 *   • the original label text  (e.g. "Coal")
 *   • a CC-number key          (e.g. "cc:1")
 * and whose values are the desired replacement strings.
 *
 * @returns {Record<string, string>}
 */
function loadLabelOverrides() {
  const filePath = config.labelOverridesFile;
  if (!filePath) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const count = Object.keys(parsed).length;
      if (count > 0) {
        console.log(`[LABELS]   Loaded ${count} override(s) from "${filePath}"`);
      } else {
        console.log(`[LABELS]   "${filePath}" is empty – using auto-detected names.`);
      }
      return parsed;
    }
    console.warn(`[LABELS]   "${filePath}" must be a JSON object – ignoring.`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[LABELS]   Could not read "${filePath}": ${err.message}`);
    }
  }
  return {};
}

/**
 * Apply the label-override map to the discovered sliders array in-place.
 * Matching priority: "cc:<N>" key first, then original-label key.
 * Each slider's `label` is reset to `originalLabel` before overrides are
 * applied so the function is safely idempotent.
 *
 * @param {Array<{index:number, label:string, originalLabel:string, min:number, max:number, step:number, value:number}>} sliderArr
 * @param {Record<string, string>} overrides
 * @param {number} ccOffset  First CC number (mirrors config.ccOffset).
 */
function applyLabelOverrides(sliderArr, overrides, ccOffset) {
  sliderArr.forEach((slider) => {
    if (slider.originalLabel !== undefined) {
      slider.label = slider.originalLabel;
    }
  });
  if (!overrides || Object.keys(overrides).length === 0) return;
  sliderArr.forEach((slider, i) => {
    const cc = ccOffset + i;
    const ccKey = `cc:${cc}`;
    if (Object.prototype.hasOwnProperty.call(overrides, ccKey)) {
      slider.label = overrides[ccKey];
    } else if (Object.prototype.hasOwnProperty.call(overrides, slider.originalLabel)) {
      slider.label = overrides[slider.originalLabel];
    }
  });
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
    return inputs.map((input, index) => {
      const label = findLabel(input, index);
      return {
        index,
        label,
        originalLabel: label,
        min: parseFloat(input.min !== '' ? input.min : 0),
        max: parseFloat(input.max !== '' ? input.max : 100),
        step: parseFloat(input.step !== '' ? input.step : 1) || 0,
        value: parseFloat(input.value !== '' ? input.value : 0),
      };
    });
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

      // Dispatch both events so the framework and any plain-JS listeners both fire
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    sliderIndex,
    value
  );
}

// ---------------------------------------------------------------------------
// HTTP admin server
// ---------------------------------------------------------------------------

/** HTML page served at GET / */
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EN-ROADS Slider Labels</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f4f6f8; color: #1a1a2e; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    p.subtitle { color: #555; margin-bottom: 1.5rem; font-size: 0.9rem; }
    table { width: 100%; border-collapse: collapse; background: #fff;
            border-radius: 8px; overflow: hidden;
            box-shadow: 0 1px 4px rgba(0,0,0,.1); }
    thead { background: #1a1a2e; color: #fff; }
    th, td { padding: 0.6rem 0.9rem; text-align: left; font-size: 0.9rem; }
    tbody tr:nth-child(even) { background: #f9fafb; }
    td input[type="text"] { width: 100%; border: 1px solid #ccc; border-radius: 4px;
                             padding: 0.3rem 0.5rem; font-size: 0.9rem; }
    td input[type="text"]:focus { outline: none; border-color: #4a90e2; }
    .actions { margin-top: 1.25rem; display: flex; gap: 0.75rem; align-items: center; }
    button { padding: 0.55rem 1.4rem; border: none; border-radius: 5px; cursor: pointer;
             font-size: 0.9rem; font-weight: 600; transition: opacity .15s; }
    button:hover { opacity: .85; }
    #saveBtn  { background: #2ecc71; color: #fff; }
    #resetBtn { background: #e74c3c; color: #fff; }
    #status { font-size: 0.85rem; padding: 0.4rem 0.8rem; border-radius: 4px; display: none; }
    #status.ok  { display: inline-block; background: #d4edda; color: #155724; }
    #status.err { display: inline-block; background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <h1>EN-ROADS Slider Labels</h1>
  <p class="subtitle">Edit the display name for each slider, then click <strong>Save</strong>.</p>
  <table>
    <thead>
      <tr><th>CC #</th><th>Original label</th><th>Display name</th></tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
  <div class="actions">
    <button id="saveBtn">Save changes</button>
    <button id="resetBtn">Reset to defaults</button>
    <span id="status"></span>
  </div>
  <script>
    const tbody = document.getElementById('tbody');
    const saveBtn = document.getElementById('saveBtn');
    const resetBtn = document.getElementById('resetBtn');
    const status = document.getElementById('status');

    function showStatus(msg, isOk) {
      status.textContent = msg;
      status.className = isOk ? 'ok' : 'err';
      setTimeout(() => { status.className = ''; }, 3000);
    }

    async function loadSliders() {
      const res = await fetch('/api/sliders');
      if (!res.ok) { showStatus('Failed to load sliders', false); return; }
      const sliders = await res.json();
      tbody.innerHTML = '';
      sliders.forEach(s => {
        const tr = document.createElement('tr');
        tr.dataset.cc = s.cc;
        tr.dataset.original = s.originalLabel;
        tr.innerHTML =
          '<td>' + s.cc + '</td>' +
          '<td>' + escHtml(s.originalLabel) + '</td>' +
          '<td><input type="text" value="' + escHtml(s.label) + '" placeholder="' + escHtml(s.originalLabel) + '"></td>';
        tbody.appendChild(tr);
      });
    }

    function escHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    saveBtn.addEventListener('click', async () => {
      const overrides = {};
      tbody.querySelectorAll('tr').forEach(tr => {
        const input = tr.querySelector('input');
        const val = input.value.trim();
        const orig = tr.dataset.original;
        if (val && val !== orig) {
          overrides[orig] = val;
        }
      });
      const res = await fetch('/api/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overrides),
      });
      if (res.ok) {
        showStatus('Saved!', true);
        await loadSliders();
      } else {
        const err = await res.text();
        showStatus('Error: ' + err, false);
      }
    });

    resetBtn.addEventListener('click', async () => {
      const res = await fetch('/api/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        showStatus('Reset to defaults!', true);
        await loadSliders();
      } else {
        showStatus('Reset failed', false);
      }
    });

    loadSliders();
  </script>
</body>
</html>`;

/**
 * Start the HTTP admin server.
 *
 * @param {() => Array} getSliders  Returns the live sliders array.
 * @param {(overrides: Record<string,string>) => void} setOverrides
 *   Called with the new override map; must apply + persist.
 */
function startAdminServer(getSliders, setOverrides) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ADMIN_HTML);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/sliders') {
      const sliderArr = getSliders();
      const payload = sliderArr.map((s, i) => ({
        cc: config.ccOffset + i,
        label: s.label,
        originalLabel: s.originalLabel,
        min: s.min,
        max: s.max,
        step: s.step,
        value: s.value,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/labels') {
      const MAX_BODY = 1024 * 1024; // 1 MB
      let body = '';
      let bodySize = 0;
      req.on('data', (chunk) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY) {
          req.destroy();
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload too large');
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        let overrides;
        try {
          overrides = JSON.parse(body);
          if (typeof overrides !== 'object' || Array.isArray(overrides) || overrides === null) {
            throw new Error('Body must be a JSON object');
          }
          for (const [k, v] of Object.entries(overrides)) {
            if (typeof k !== 'string' || typeof v !== 'string') {
              throw new Error('All keys and values must be strings');
            }
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(`Invalid JSON: ${err.message}`);
          return;
        }

        // Persist to file (best-effort)
        const filePath = config.labelOverridesFile;
        if (filePath) {
          try {
            fs.writeFileSync(filePath, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
            console.log(`[ADMIN]    Saved ${Object.keys(overrides).length} override(s) to "${filePath}"`);
          } catch (err) {
            console.warn(`[ADMIN]    Could not write "${filePath}": ${err.message}`);
          }
        }

        // Apply in-memory
        setOverrides(overrides);
        console.log('[ADMIN]    Label overrides updated.');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(config.httpPort, '127.0.0.1', () => {
    console.log(`[ADMIN]    Admin UI available at http://localhost:${config.httpPort}/`);
  });

  server.on('error', (err) => {
    console.warn(`[ADMIN]    HTTP server error: ${err.message}`);
  });
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
  // 3. Discover sliders, apply any user-defined label overrides, and
  //    assign CC numbers
  // ------------------------------------------------------------------
  sliders = await discoverSliders();
  let labelOverrides = loadLabelOverrides();
  applyLabelOverrides(sliders, labelOverrides, config.ccOffset);
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
      applyLabelOverrides(sliders, labelOverrides, config.ccOffset);
      await injectSliderListeners();
      console.log(`[PAGE]     Re-injected listeners after navigation (${sliders.length} sliders)`);
    } catch {
      // Page may have navigated away intentionally
    }
  });

  // ------------------------------------------------------------------
  // 6. HTTP admin UI – lets the user rename sliders from a browser
  // ------------------------------------------------------------------
  if (config.httpPort) {
    startAdminServer(
      () => sliders,
      (newOverrides) => {
        labelOverrides = newOverrides;
        applyLabelOverrides(sliders, labelOverrides, config.ccOffset);
      },
    );
  }

  // ------------------------------------------------------------------
  // 7. Graceful shutdown
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
  if (config.httpPort) {
    console.log(`→ Open http://localhost:${config.httpPort}/ to rename sliders from the browser.`);
  }
  console.log('   Press Ctrl+C to exit.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
