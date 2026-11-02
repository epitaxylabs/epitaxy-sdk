"""Thin client for the Epitaxy API (MCP tools over HTTP JSON-RPC). One dependency: httpx."""
from __future__ import annotations

import base64
import itertools
import json
import os
import time
from pathlib import Path
from typing import Any, Mapping, Union

import httpx

DEFAULT_URL = "https://epitaxy.dev"
INLINE_LIMIT = 3_000_000          # bytes; larger firmware goes through a presigned upload URL
SERVER_WAIT_S = 50                # the server holds a wait call at most this long

FileSource = Union[str, os.PathLike, bytes]


class EpitaxyError(RuntimeError):
    """The API rejected a call (bad key, invalid plan, unknown job, ...)."""


class Job:
    """A submitted test job. Fields mirror the API's job view; `raw` has everything."""

    def __init__(self, client: "Epitaxy", data: dict):
        self._c = client
        self.raw: dict = data

    # common fields
    id = property(lambda self: self.raw.get("job_id"))
    state = property(lambda self: self.raw.get("state"))            # queued | running | done | cancelled
    verdict = property(lambda self: self.raw.get("verdict"))        # pass | fail | error | None (not finished)
    summary = property(lambda self: self.raw.get("summary", ""))
    problems = property(lambda self: self.raw.get("problems", []))
    artifacts = property(lambda self: self.raw.get("artifacts", []))
    board = property(lambda self: f"{self.raw.get('station')}/{self.raw.get('slot')}" if self.raw.get("station") else None)

    @property
    def done(self) -> bool:
        return self.state in ("done", "cancelled")

    @property
    def passed(self) -> bool:
        return self.verdict == "pass"

    def refresh(self, detail: bool = False) -> "Job":
        self.raw = self._c.call("get_result", job_id=self.id, detail=detail)
        return self

    def wait(self, timeout_s: float = 600) -> "Job":
        end = time.monotonic() + timeout_s
        while not self.done:
            left = end - time.monotonic()
            if left <= 0:
                break
            self.raw = self._c.call("wait_for_result", job_id=self.id, timeout_s=min(SERVER_WAIT_S, left))
        return self

    def cancel(self) -> "Job":
        self.raw = self._c.call("cancel_job", job_id=self.id)
        return self

    def text(self, name: str) -> str:
        """A text artifact (console_N.txt, flash_N.log, emulator_N.log, result.json); last 20 kB if long."""
        return self._c.call("get_artifact", job_id=self.id, name=name)["text"]

    def download(self, name: str, dest: str | os.PathLike = ".") -> Path:
        """Download any artifact (including binary captures) into `dest` (a directory or a file path)."""
        url = self._c.call("get_artifact_url", job_id=self.id, name=name)["url"]
        dest = Path(dest)
        path = dest / name if dest.is_dir() or str(dest).endswith(("/", "\\")) else dest
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._c._http.stream("GET", url) as r:
            r.raise_for_status()
            with open(path, "wb") as f:
                for chunk in r.iter_bytes():
                    f.write(chunk)
        return path

    def __repr__(self):
        return f"<Job {self.id} {self.state} {self.verdict or ''}>".replace(" >", ">")


class Epitaxy:
    def __init__(self, api_key: str | None = None, base_url: str | None = None, timeout_s: float = 90):
        self.api_key = api_key or os.environ.get("EPITAXY_API_KEY")
        if not self.api_key:
            raise EpitaxyError("no API key: pass api_key=... or set EPITAXY_API_KEY "
                               "(create one at https://epitaxy.dev/account/)")
        self.base_url = (base_url or os.environ.get("EPITAXY_URL") or DEFAULT_URL).rstrip("/")
        self._http = httpx.Client(timeout=timeout_s)
        self._ids = itertools.count(1)

    def close(self):
        self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ------------------------------------------------------------------ raw tool call
    def call(self, tool: str, **arguments: Any) -> Any:
        """Call one API tool by name and return its result (dict or list). Raises EpitaxyError on errors."""
        body = {"jsonrpc": "2.0", "id": next(self._ids), "method": "tools/call",
                "params": {"name": tool, "arguments": {k: v for k, v in arguments.items() if v is not None}}}
        r = self._http.post(self.base_url + "/mcp", json=body, headers={
            "Authorization": f"Bearer {self.api_key}", "Accept": "application/json, text/event-stream"})
        if r.status_code == 401:
            raise EpitaxyError("invalid or revoked API key")
        if r.status_code >= 400:
            raise EpitaxyError(f"HTTP {r.status_code}: {r.text[:300]}")
        msg = r.json()
        if "error" in msg:
            raise EpitaxyError(msg["error"].get("message", str(msg["error"])))
        res = msg["result"]
        sc = res.get("structuredContent")
        if sc is not None:
            out = sc["result"] if set(sc) == {"result"} else sc
        else:
            text = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type", "text") == "text")
            try:
                out = json.loads(text)
            except ValueError:
                out = text
        if res.get("isError"):
            raise EpitaxyError(out if isinstance(out, str) else json.dumps(out))
        if isinstance(out, dict) and "error" in out and len(out) <= 2:
            raise EpitaxyError(out["error"])
        return out

    # ------------------------------------------------------------------ API
    def boards(self) -> dict:
        """Stations, boards, wired/capturable pins and rig capabilities."""
        return self.call("list_boards")

    def plan_guide(self, include_schema: bool = False) -> dict:
        """The test-plan format guide (and JSON schema)."""
        return self.call("get_plan_guide", include_schema=include_schema)

    def validate(self, plan: dict | str | os.PathLike) -> dict:
        """Check a plan against the schema and the boards that could run it (nothing is run)."""
        return self.call("validate_plan", plan=_load_plan(plan))

    def submit(self, plan: dict | str | os.PathLike, files: Mapping[str, FileSource] | None = None,
               wait_s: float = 0) -> Job:
        """Submit a plan. `files` maps each file name used in the plan's images to a local path or bytes.
        wait_s > 0 blocks until the job finishes (or the time runs out)."""
        plan = _load_plan(plan)
        blobs = {name: _read(src) for name, src in (files or {}).items()}
        inline, uploads = {}, {}
        total = sum(len(b) for b in blobs.values())
        for name, data in blobs.items():
            if total <= INLINE_LIMIT:
                inline[name] = base64.b64encode(data).decode()
            else:
                up = self.call("create_upload_url", name=name.rsplit("/", 1)[-1])
                self._http.put(up["upload_url"], content=data).raise_for_status()
                uploads[name] = up["file_ref"]
        out = self.call("submit_test", plan=plan, files_base64=inline or None, uploads=uploads or None,
                        wait_s=min(wait_s, SERVER_WAIT_S))
        if not out.get("accepted", True):
            raise EpitaxyError("; ".join(out.get("errors") or ["rejected"]))
        job = Job(self, out)
        if wait_s > SERVER_WAIT_S and not job.done:
            job.wait(wait_s - SERVER_WAIT_S)
        return job

    def job(self, job_id: str, detail: bool = False) -> Job:
        return Job(self, self.call("get_result", job_id=job_id, detail=detail))

    def jobs(self, limit: int = 20) -> list[dict]:
        return self.call("list_jobs", limit=limit)


def _load_plan(plan) -> dict:
    if isinstance(plan, dict):
        return plan
    return json.loads(Path(plan).read_text(encoding="utf-8"))


def _read(src: FileSource) -> bytes:
    if isinstance(src, (bytes, bytearray)):
        return bytes(src)
    return Path(src).read_bytes()
