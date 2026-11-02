"""Epitaxy: run firmware tests on real MCU dev boards.

    from epitaxy import Epitaxy
    ep = Epitaxy()                         # EPITAXY_API_KEY from the environment
    job = ep.submit("plan.json", files={"build/app.elf": "build/app.elf"}, wait_s=120)
    print(job.verdict, job.summary)
"""
from .client import Epitaxy, EpitaxyError, Job

__all__ = ["Epitaxy", "EpitaxyError", "Job"]
__version__ = "0.1.0"
