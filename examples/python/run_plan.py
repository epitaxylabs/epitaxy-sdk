"""Run a test plan on a real board and print the result.

    pip install "git+https://github.com/epitaxylabs/epitaxy-sdk#subdirectory=python"
    export EPITAXY_API_KEY=fpu_...
    python run_plan.py ../plans/blinky.json build/app.elf          # the plan's image file -> your local build
    python run_plan.py ../try-it/plan.json ../try-it/sim_fw/demo.json   # try it now on the simulated station
"""
import json
import sys

from epitaxy import Epitaxy

plan_path, firmware = sys.argv[1], sys.argv[2]
plan = json.load(open(plan_path))
image_name = next(iter(plan["images"].values()))["file"]     # the name the plan expects for the firmware

with Epitaxy() as ep:
    v = ep.validate(plan)
    if not v.get("runnable"):
        sys.exit(f"no board can run this plan: {v}")
    job = ep.submit(plan, files={image_name: firmware}, wait_s=300)
    print(job.summary or job.raw)
    for name in job.artifacts:
        if name.startswith("console_"):
            print(f"--- {name}\n{job.text(name)}")
    sys.exit(0 if job.passed else 1)
