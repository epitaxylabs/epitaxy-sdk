# Try it now

`plan.json` exercises most of the plan format (console, memory, current, captures with UART/I²C decode, a
button-to-echo latency check). `sim_fw/demo.json` is not real firmware: it describes the behaviour of a
**simulated** NUCLEO-F411RE (`"format": "sim"`), which runs on Epitaxy's simulated station. Use it to try the API
and see what results look like before you point a plan at your own build.

```bash
python ../python/run_plan.py plan.json sim_fw/demo.json
```
