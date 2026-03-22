# EN-ROADS → MIDI Bridge

A bidirectional MIDI controller bridge for the
[EN-ROADS](https://en-roads.climateinteractive.org/) climate-policy simulator.

Every slider on the EN-ROADS page is mapped to a unique MIDI Control-Change
(CC) message so that:

* **Moving a slider in EN-ROADS** sends a MIDI CC message (0–127) to your DAW
  (e.g. Ableton Live).
* **Sending a MIDI CC message from your DAW** moves the corresponding EN-ROADS
  slider in realtime.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 (tested on v24) |
| npm | ≥ 9 |
| Operating system | macOS, Linux, Windows |

### Platform-specific MIDI requirements

| OS | What you need |
|---|---|
| **macOS** | Enable the **IAC Driver** in *Audio MIDI Setup → MIDI Studio* (built-in). |
| **Windows** | Install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) to create a virtual MIDI port. |
| **Linux** | ALSA is used directly. Virtual ports are created automatically. |

---

## Installation

```bash
npm install
```

Puppeteer will automatically download a compatible version of Chromium.

---

## Usage

```bash
npm start
```

The app will:
1. Open a Chromium window pointing at EN-ROADS v26.3.0.
2. Discover all range-input sliders on the page.
3. Print a mapping table showing which CC number corresponds to each slider.
4. Start listening for slider changes and incoming MIDI CC messages.

### Example console output

```
EN-ROADS ↔ MIDI Bridge starting…
URL       : https://en-roads.climateinteractive.org/scenario.html?v=26.3.0
Channel   : 1
CC offset : 1
Headless  : false

[MIDI OUT] Created virtual port: "ENROADS OUT"
[MIDI IN]  Created virtual port: "ENROADS IN"

Loading EN-ROADS…

Found 32 slider(s):

  CC  1  "Coal"          [−100 – 200, step 1]  current: 0
  CC  2  "Oil"           [−100 – 200, step 1]  current: 0
  CC  3  "Natural Gas"   [−100 – 200, step 1]  current: 0
  …

Bridge is running.
→ Move sliders in EN-ROADS to send MIDI CC messages to your DAW.
→ Send MIDI CC messages from your DAW to move EN-ROADS sliders in realtime.
   Press Ctrl+C to exit.
```

---

## Configuration

All settings are controlled via environment variables:

| Variable | Default | Description |
|---|---|---|
| `MIDI_OUTPUT_NAME` | *(first available port)* | Exact name of the MIDI output port to send messages to. |
| `MIDI_INPUT_NAME` | *(first available port)* | Exact name of the MIDI input port to receive messages from. |
| `MIDI_CHANNEL` | `1` | MIDI channel (1–16). |
| `CC_OFFSET` | `1` | CC number assigned to the first discovered slider. |
| `HEADLESS` | `false` | Set to `true` to hide the Chromium window. |
| `ENROADS_URL` | `https://en-roads.climateinteractive.org/scenario.html?v=26.3.0` | EN-ROADS URL to load. |

### Example – use a specific MIDI port

```bash
MIDI_OUTPUT_NAME="loopMIDI Port" MIDI_INPUT_NAME="loopMIDI Port" npm start
```

---

## Connecting to Ableton Live

1. **Start the bridge** with `npm start`.  
   You will see either "Connected to port …" or "Created virtual port: ENROADS OUT / ENROADS IN".

2. **In Ableton Live → Preferences → Link / Tempo / MIDI**:
   - Enable **Track** and **Remote** for the *ENROADS OUT* / *ENROADS IN* ports
     (or whatever ports appeared in the bridge console).

3. **MIDI Map mode** (`Ctrl+M` / `Cmd+M` in Ableton):
   - Click a parameter you want to control.
   - Move the corresponding slider in EN-ROADS – Ableton will learn the CC.

4. **Reverse direction** – move the mapped Ableton knob/fader to see the EN-ROADS
   slider move in the browser in realtime.

---

## Slider ↔ CC mapping

Sliders are discovered in DOM order and assigned CC numbers starting at
`CC_OFFSET` (default 1).  The mapping is printed to the console on startup.

### Value scaling

```
slider → MIDI : round( (value − min) / (max − min) × 127 )
MIDI → slider : min + (midiValue / 127) × (max − min), snapped to step
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Node.js process (index.js)                         │
│                                                     │
│  ┌─────────────┐       ┌──────────────────────────┐ │
│  │  @julusian/ │       │  Puppeteer (Chromium)    │ │
│  │    midi     │       │                          │ │
│  │             │       │  EN-ROADS page           │ │
│  │  MIDI OUT ──┼──────►│  (injected listeners)    │ │
│  │  MIDI IN  ◄─┼───────┤                          │ │
│  └─────────────┘       └──────────────────────────┘ │
│         ▲ ▼                                         │
└─────────┼─┼───────────────────────────────────────┘
          │ │
   Virtual MIDI port
          │ │
    ┌─────┴─┴────┐
    │  Ableton   │
    │    Live    │
    └────────────┘
```

---

## License

MIT
