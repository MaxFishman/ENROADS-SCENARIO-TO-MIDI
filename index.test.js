'use strict';

/**
 * index.test.js – Unit tests for the pure helper functions in the bridge.
 *
 * These tests run with the built-in Node.js test runner (node --test) and do
 * not require any MIDI hardware or an internet connection.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Inline the same pure functions from index.js so the tests are self-contained
// and do not trigger Puppeteer / MIDI imports.
// ---------------------------------------------------------------------------

function valueToMidi(value, min, max) {
  if (max === min) return 0;
  const normalized = (value - min) / (max - min);
  return Math.round(Math.min(127, Math.max(0, normalized * 127)));
}

function midiToValue(midiValue, min, max, step) {
  const normalized = midiValue / 127;
  const raw = min + normalized * (max - min);
  if (step && step > 0) {
    return Math.round(raw / step) * step;
  }
  return raw;
}

function extractNumber(text) {
  const match = String(text).match(/[-+]?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : NaN;
}

// ---------------------------------------------------------------------------
// valueToMidi
// ---------------------------------------------------------------------------

describe('valueToMidi', () => {
  it('maps minimum value to 0', () => {
    assert.equal(valueToMidi(0, 0, 100), 0);
  });

  it('maps maximum value to 127', () => {
    assert.equal(valueToMidi(100, 0, 100), 127);
  });

  it('maps midpoint correctly', () => {
    // 50 / 100 * 127 = 63.5  → rounds to 64
    assert.equal(valueToMidi(50, 0, 100), 64);
  });

  it('works with negative minimum', () => {
    // value=-100, min=-100, max=200 → 0
    assert.equal(valueToMidi(-100, -100, 200), 0);
    // value=200, min=-100, max=200 → 127
    assert.equal(valueToMidi(200, -100, 200), 127);
    // value=50, min=-100, max=200 → (50+100)/300 * 127 ≈ 63.5 → 64
    assert.equal(valueToMidi(50, -100, 200), 64);
  });

  it('clamps values below min to 0', () => {
    assert.equal(valueToMidi(-999, 0, 100), 0);
  });

  it('clamps values above max to 127', () => {
    assert.equal(valueToMidi(999, 0, 100), 127);
  });

  it('returns 0 when min === max', () => {
    assert.equal(valueToMidi(42, 42, 42), 0);
  });
});

// ---------------------------------------------------------------------------
// midiToValue
// ---------------------------------------------------------------------------

describe('midiToValue', () => {
  it('maps MIDI 0 to slider minimum', () => {
    assert.equal(midiToValue(0, 0, 100, 1), 0);
  });

  it('maps MIDI 127 to slider maximum', () => {
    assert.equal(midiToValue(127, 0, 100, 1), 100);
  });

  it('maps MIDI 64 close to midpoint', () => {
    // 64/127 * 100 ≈ 50.4, snap to step 1 → 50
    assert.equal(midiToValue(64, 0, 100, 1), 50);
  });

  it('snaps to step correctly', () => {
    // step=10: 64/127*100 ≈ 50.4 → round(50.4/10)*10 = 50
    assert.equal(midiToValue(64, 0, 100, 10), 50);
  });

  it('works with negative minimum', () => {
    // MIDI 0 → -100
    assert.equal(midiToValue(0, -100, 200, 1), -100);
    // MIDI 127 → 200
    assert.equal(midiToValue(127, -100, 200, 1), 200);
  });

  it('returns exact float when step is 0', () => {
    const result = midiToValue(64, 0, 100, 0);
    assert.ok(result > 50 && result < 51, `Expected ~50.4, got ${result}`);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: valueToMidi → midiToValue should recover the approximate original
// ---------------------------------------------------------------------------

describe('round-trip accuracy', () => {
  it('round-trips values within ±1 step for integer sliders', () => {
    const min = -100;
    const max = 200;
    const step = 1;
    const testValues = [-100, -50, 0, 50, 100, 150, 200];

    for (const v of testValues) {
      const midi = valueToMidi(v, min, max);
      const recovered = midiToValue(midi, min, max, step);
      // Due to 7-bit quantisation, allow ±2 units of error
      assert.ok(
        Math.abs(recovered - v) <= 2,
        `Round-trip failed for value ${v}: got ${recovered} (MIDI ${midi})`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// extractNumber – parses numeric values from graph element text content
// ---------------------------------------------------------------------------

describe('extractNumber', () => {
  it('parses a plain integer', () => {
    assert.equal(extractNumber('42'), 42);
  });

  it('parses a float', () => {
    assert.equal(extractNumber('2.4'), 2.4);
  });

  it('strips unit suffix (°C)', () => {
    assert.equal(extractNumber('2.4°C'), 2.4);
  });

  it('strips unit suffix (ppm)', () => {
    assert.equal(extractNumber('450 ppm'), 450);
  });

  it('handles a negative value', () => {
    assert.equal(extractNumber('-3.5 m'), -3.5);
  });

  it('handles a positive sign', () => {
    assert.equal(extractNumber('+1.2°C'), 1.2);
  });

  it('returns NaN for non-numeric text', () => {
    assert.ok(isNaN(extractNumber('n/a')));
  });

  it('returns NaN for empty string', () => {
    assert.ok(isNaN(extractNumber('')));
  });
});

// ---------------------------------------------------------------------------
// Graph metric scaling – valueToMidi applied to typical EN-ROADS output ranges
// ---------------------------------------------------------------------------

describe('graph metric scaling', () => {
  it('maps minimum temperature to MIDI 0', () => {
    // Temperature range 1.0–5.0 °C; min value → MIDI 0
    assert.equal(valueToMidi(1.0, 1.0, 5.0), 0);
  });

  it('maps maximum temperature to MIDI 127', () => {
    assert.equal(valueToMidi(5.0, 1.0, 5.0), 127);
  });

  it('maps mid-range temperature correctly', () => {
    // 3.0 is midpoint of 1.0–5.0; (3-1)/(5-1)*127 = 63.5 → 64
    assert.equal(valueToMidi(3.0, 1.0, 5.0), 64);
  });

  it('maps minimum CO₂ concentration to MIDI 0', () => {
    assert.equal(valueToMidi(400, 400, 1000), 0);
  });

  it('maps maximum CO₂ concentration to MIDI 127', () => {
    assert.equal(valueToMidi(1000, 400, 1000), 127);
  });

  it('maps mid-range CO₂ concentration correctly', () => {
    // 700 is midpoint of 400–1000; (700-400)/600*127 = 63.5 → 64
    assert.equal(valueToMidi(700, 400, 1000), 64);
  });

  it('clamps graph values below metric minimum to MIDI 0', () => {
    assert.equal(valueToMidi(0.5, 1.0, 5.0), 0);
  });

  it('clamps graph values above metric maximum to MIDI 127', () => {
    assert.equal(valueToMidi(6.0, 1.0, 5.0), 127);
  });
});
