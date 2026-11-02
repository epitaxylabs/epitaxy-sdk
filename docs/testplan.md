# Writing a test plan (fp-testplan/0.1)

This page is written for the LLM (or person) that writes plans. Machine-readable schema:
`schema/fp-testplan-0.1.json`. Full example: `examples/try-it/plan.json`. Check a plan without running it
with `ep.validate(plan)` (Python / TypeScript) or the `validate_plan` MCP tool.

## Shape

```json
{
  "schema": "fp-testplan/0.1",
  "name": "short name",
  "target": {"board": "NUCLEO-F411RE", "mcu": "STM32F411RETx"},
  "images": {"app": {"file": "build/app.elf", "format": "elf"}},
  "power": {"vdd": 3.3},
  "signals": {"LED": "PA5", "TX": "PA2"},
  "timeout_s": 60,
  "steps": [ ... ]
}
```

- `signals` maps your names to **MCU pin names**. You never name station hardware; the station maps pins to
  its channels. A plan that uses a pin the board isn't wired for is rejected before anything runs.
- Steps run in order. A failed step stops the job unless it has `"continue_on_fail": true`.
- The DUT is powered on before step 0 and off after the last step.
- Use `elf` images when you can: `memory` steps by symbol need the ELF.

## Steps

| type | what it does | key fields |
|---|---|---|
| `flash` | Program an image; resets and runs it by default | `image`, `verify`, `run` |
| `reset` | Pulse the reset pin (or reset via the probe) | `method`, `hold_ms` |
| `power` | Board power `on` / `off` / `cycle` | `state`, `off_ms` |
| `wait` | Sleep | `ms` |
| `console` | Wait for a regex on the board's UART console (VCOM). Resets first so boot text is caught | `pattern`, `within_ms`, `baud`, `absent` |
| `memory` | Read a variable through the debug probe | `symbol` or `address`, `ctype`, `expect` and/or `changes` |
| `current` | MCU (`idd`) or whole-board (`vbus`) current | `duration_ms`, `avg_ma`, `peak_ma` |
| `drive` | Drive a DUT **input** high/low (or release it) | `signal`, `level`, `pulse_ms` |
| `capture` | Record signals with the logic analyzer, run `during` actions, evaluate `checks` | `signals` (≤ 16), `duration_ms`, `during`, `checks` |
| `emulate` | Act as a peripheral for the DUT (T8) while nested `steps` run, then check what it saw | `device`, `steps`, `expect_i2c` / `expect_received_text` |

Actions allowed in `capture.during`: `drive`, `reset`, `power`, `wait`, and **`pattern`** (T7). A pattern is a
waveform played into a DUT input with ~7 ns timing:

```json
{"type": "pattern", "signal": "BTN", "square": {"hz": 100, "duty_pct": 30}, "repeat": 0, "at_ms": 20}
{"type": "pattern", "signal": "ENC_A", "edges": [[1, 250], [0, 250]], "repeat": 40, "init": "low", "at_ms": 10}
```

- `edges` is a list of `[level, microseconds]` pairs, played `repeat` times. With `square`, `repeat` is the
  number of periods.
- `repeat: 0` plays until the capture ends.
- After a finite pattern the pin holds the last level.
- Patterns with the same `at_ms` start on the same clock.
- The pin is contention-checked for both levels first.

## Emulating a peripheral (T8)

The rig plays the device the firmware talks to, such as a sensor or a modem. The nested `steps` run while the
device is live. Afterwards the station checks what the emulator saw.

```json
{"type": "emulate",
 "device": {"kind": "i2c_target", "scl": "SCL", "sda": "SDA", "addr": 72, "registers": {"0x00": "0c 80"}},
 "steps": [{"type": "console", "pattern": "temp_raw=3200", "within_ms": 500, "from_reset": false}],
 "expect_i2c": [{"addr": 72, "rw": "write", "data": "00"}, {"addr": 72, "rw": "read", "data": "0c 80"}]}
```

- **`i2c_target`:** a register-file device. A write's first byte sets the register pointer; further bytes are
  stored, and reads auto-increment. The rig provides the 2.2 k pull-ups. A DUT addressing the wrong address
  shows up as an `ack: false` transaction.
- **`uart_peer`:** set `listen` to the DUT's TX pin and `talk` to its RX pin, plus `baud`, `echo`, and
  `replies: [{"match": "AT\r\n", "reply": "OK\r\n"}]` (text, or hex with `match_is_hex`/`reply_is_hex`). Check
  what the DUT sent with `expect_received_text` / `expect_received_hex`.
- **Nested steps:** `wait`, `reset`, `console`, `memory`, `current` and `capture`. Use `"from_reset": false` on
  console steps unless you want the DUT reset while the device is live.
- **Time limit:** the whole block holds the rig, so keep it under 60 s.
- **SPI targets:** not on R1, which has only two stimulus buses. They need v0.9's four.

## Capture checks (`checks[].kind`)

| kind | measures | `expect` unit |
|---|---|---|
| `frequency` | rising-edge rate | Hz |
| `duty` | % high over whole periods | % |
| `pulse_width` | `polarity` high/low, `stat` min/max/mean | µs |
| `edge_count` | number of `rising`/`falling`/`any` edges | count |
| `level` | `high`/`low` throughout, or `at_ms` | — |
| `latency` | first `start` edge → first `end` edge after it | µs |
| `uart` | decode TX line; `contains_text`, `contains_hex`, `pattern` | — |
| `spi` | decode with `sck`, `mosi`, `miso`, `cs`, `mode`; `expect` = transfers in order (one per CS frame) | hex |
| `i2c` | decode `scl`/`sda`; `expect` = transactions `{addr, rw, data, ack}` in order | hex |

Numeric expectations: `{"min": a, "max": b}`, or `{"value": v, "tol": t}` / `{"value": v, "tol_pct": p}`.

## Rules that avoid false failures

1. **Let the firmware boot before measuring.** After `flash`/`reset`/`power`, add a `console` step that
   waits for a ready message, or a `wait` covering the boot time. A capture started at reset records the boot.
2. **Only drive inputs.** Before driving, the station pulls the pin weakly and checks it follows. If the
   firmware drives that pin, the step fails ("does not follow a weak pull") instead of fighting it.
3. **Make captures long enough** to contain several periods or the whole transaction. A periodic event
   every 100 ms needs a capture over 200 ms.
4. **Inside `capture.during`, time with `at_ms`** (offset from capture start), not `wait` steps. Leave
   ~20 ms before the first action.
5. **Keep tolerances realistic:** jumper wires and ~10 ns LA resolution (100 MS/s). Fast timing (< 1 µs)
   needs a sample rate set explicitly (`samplerate_hz`).
6. Protocol limits on this station: UART ≤ 3 Mbaud, SPI ≤ 10 MHz, I²C ≤ 1 MHz.

## Not in 0.1 yet

RTT console, SPI target emulation (needs 4 stimulus buses), analog input/output and waveform checks (T9–T11),
power-cycle brown-out profiles (T13 beyond `power: cycle`).
