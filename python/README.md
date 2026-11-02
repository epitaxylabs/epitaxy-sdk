# epitaxy (Python)

Client for [epitaxy.dev](https://epitaxy.dev): run firmware tests on real MCU dev boards.

```python
from epitaxy import Epitaxy
ep = Epitaxy()        # EPITAXY_API_KEY from the environment
job = ep.submit("plan.json", files={"build/app.elf": "build/app.elf"}, wait_s=120)
print(job.verdict, job.summary)
```

See the [repository README](https://github.com/epitaxylabs/epitaxy-sdk) for the plan format and MCP setup.
