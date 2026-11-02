# Epitaxy SDK

**Real hardware tests for AI-written firmware.** [Epitaxy](https://epitaxy.dev) flashes your firmware onto a real
MCU dev board, drives its pins, measures them with logic analyzers, scopes and current sense, and returns
pass/fail against your test plan, with the measurements and captures behind every verdict.

This repo has the client side: Python and TypeScript clients, MCP setup for coding agents, the test-plan format,
and runnable examples. Questions, ideas and board requests go to
[Discussions](https://github.com/epitaxylabs/epitaxy-sdk/discussions).

> Early access. The API is versioned by the plan schema (`fp-testplan/0.1`); breaking changes get a new version.

## 1. Get an API key

Sign up at **[epitaxy.dev](https://epitaxy.dev)**, open **Account → API keys → Create key**, and export it:

```bash
export EPITAXY_API_KEY=fpu_...
```

New accounts get 30 free test-minutes. A test-minute is one minute of a board and its instruments running your
plan, billed per second.

## 2. Use it from a coding agent (MCP)

```bash
claude mcp add --transport http epitaxy https://epitaxy.dev/mcp \
  --header "Authorization: Bearer $EPITAXY_API_KEY"
```

Any MCP client that speaks streamable HTTP works the same way: URL `https://epitaxy.dev/mcp`, header
`Authorization: Bearer <key>`. The agent gets these tools:

| Tool | What it does |
|---|---|
| `list_boards` | Boards online, their wired and capturable pins, rig capabilities |
| `get_plan_guide` | The plan-writing guide (and JSON schema) |
| `validate_plan` | Schema check + which boards could run it; nothing runs |
| `submit_test` | Submit a plan with firmware (`files_base64`, or `uploads` for big files); optional `wait_s` |
| `wait_for_result` / `get_result` | Job state, verdict, per-check results |
| `get_artifact` / `get_artifact_url` | Console and logs as text; download URL for any artifact (captures) |
| `create_upload_url` | Presigned upload for firmware over ~3 MB |
| `list_jobs` / `cancel_job` | Your recent jobs; cancel a queued one |

Then ask: *"Build the blinky for the NUCLEO-F411RE and verify on real hardware that LED blinks at 10 Hz, 50% duty."*

## 3. Use it from code

### Python

```bash
pip install "git+https://github.com/epitaxylabs/epitaxy-sdk#subdirectory=python"
```

```python
from epitaxy import Epitaxy

ep = Epitaxy()                                    # EPITAXY_API_KEY from the environment
job = ep.submit("plan.json", files={"build/app.elf": "build/app.elf"}, wait_s=120)
print(job.verdict)                                # "pass" | "fail" | "error"
print(job.summary)
print(job.text("console_1.txt"))                  # text artifacts
job.download("capture_3.npz", "out/")             # any artifact, e.g. logic captures (numpy .npz)
```

### TypeScript / JavaScript

Zero dependencies; Node 18+, Deno, Bun or the browser. Until the npm package is published, copy
[`js/src/index.ts`](js/src/index.ts) (or `js/dist/index.js`) into your project.

```ts
import { Epitaxy } from "@epitaxy/client";
import { readFile } from "node:fs/promises";

const ep = new Epitaxy();                          // EPITAXY_API_KEY from the environment
const plan = JSON.parse(await readFile("plan.json", "utf8"));
const job = await ep.submit(plan, { files: { "build/app.elf": await readFile("build/app.elf") }, waitS: 120 });
console.log(job.verdict, job.summary);
```

### Anything else

It's JSON-RPC over HTTPS. One call:

```bash
curl -s https://epitaxy.dev/mcp \
  -H "Authorization: Bearer $EPITAXY_API_KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}'
```

## 4. Write a test plan

A plan says which board, which firmware, which pins matter, and what to do and check. A minimal one
([`examples/plans/blinky.json`](examples/plans/blinky.json)):

```json
{
  "schema": "fp-testplan/0.1",
  "name": "blinky acceptance",
  "target": { "board": "NUCLEO-F411RE" },
  "images": { "app": { "file": "build/app.elf" } },
  "signals": { "LED": "PA5" },
  "steps": [
    { "type": "flash" },
    { "type": "console", "pattern": "app ready", "within_ms": 1000 },
    { "type": "capture", "signals": ["LED"], "duration_ms": 500,
      "checks": [
        { "kind": "frequency", "signal": "LED", "expect": { "value": 10, "tol_pct": 2 } },
        { "kind": "duty", "signal": "LED", "expect": { "value": 50, "tol": 2 } } ] }
  ]
}
```

- Step types: flash, reset, power, wait, drive, console, memory, current, capture, emulate.
- Capture checks: frequency, duty, pulse_width, edge_count, level, latency, uart, spi, i2c.
- Stimulus: PIO-timed patterns during a capture. Emulated peripherals: I²C target with registers, UART peer with scripted replies.

Full guide: [`docs/testplan.md`](docs/testplan.md). JSON schema: [`schema/fp-testplan-0.1.json`](schema/fp-testplan-0.1.json).
Agents can fetch both with `get_plan_guide`.

## Examples

| Path | What |
|---|---|
| [`examples/try-it/`](examples/try-it/) | Runs right now on the simulated station: no firmware build needed |
| [`examples/plans/blinky.json`](examples/plans/blinky.json) | Minimal plan for your own NUCLEO-F411RE build |
| [`examples/python/run_plan.py`](examples/python/run_plan.py) | Validate, run, print the summary and console; exit code = verdict (CI-friendly) |
| [`examples/js/run-plan.mjs`](examples/js/run-plan.mjs) | The same in Node |

## Results

Every job returns a verdict per step and per check, with the measured value and the expectation, e.g.
`frequency LED  10.0 Hz  expect [9.8, 10.2]`. Artifacts include console logs, flash logs, emulator transcripts,
`result.json`, and raw logic captures: `capture_N.npz` holds `samples` (one uint32 word per sample), `samplerate`, and the signal `names` with their `bits` in the word. They're kept for
30 days.

## License

MIT. See [LICENSE](LICENSE).
