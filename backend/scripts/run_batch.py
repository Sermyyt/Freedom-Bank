"""Evaluate a group through a running API and print aggregate usage only.

Run from backend/: python scripts/run_batch.py --group DEV
"""
from __future__ import annotations

import argparse
from decimal import Decimal
import json
import math
import sys
import time

import httpx

DEFAULT_TIMEOUT = 2400


class BatchError(RuntimeError):
    """A safe CLI error without request URLs, response content or transcripts."""


def request_data(client, method: str, path: str, **kwargs) -> dict:
    try:
        response = client.request(method, path, **kwargs)
        if response.is_error:
            raise BatchError(f"API request failed (HTTP {response.status_code}).")
        payload = response.json()
        if not isinstance(payload, dict) or "data" not in payload:
            raise BatchError("API returned an invalid response envelope.")
        return payload["data"]
    except (httpx.HTTPError, ValueError):
        raise BatchError("API connection or JSON response failed.") from None


def wait_job(client, job_id: str, timeout: float = DEFAULT_TIMEOUT, poll_interval: float = 1) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        job = request_data(client, "GET", f"/api/jobs/{job_id}")
        if job["status"] in {"completed", "failed"}:
            return job
        if time.monotonic() >= deadline:
            raise BatchError("Polling timed out; the saved job may still be processing.")
        time.sleep(min(poll_interval, max(0, deadline - time.monotonic())))


def aggregate_usage(evaluations: list[dict]) -> dict:
    usage = [evaluation["usage"] for evaluation in evaluations]

    def known_sum(field):
        values = [entry.get(field) for entry in usage]
        return sum(values) if values and all(value is not None for value in values) else None

    currencies = {entry.get("currency") for entry in usage}
    costs = [entry.get("cost") for entry in usage]
    known_cost = bool(costs) and all(cost is not None for cost in costs) and len(currencies) == 1 and None not in currencies
    return {
        "calls": sum(entry["calls"] for entry in usage),
        "input_tokens": known_sum("input_tokens"),
        "output_tokens": known_sum("output_tokens"),
        "cost": float(sum(Decimal(str(cost)) for cost in costs)) if known_cost else None,
        "currency": next(iter(currencies)) if known_cost else None,
    }


def read_job(client, job_id: str, *, timeout: float = DEFAULT_TIMEOUT,
             poll_interval: float = 1, started: float | None = None) -> dict:
    """Wait for an existing job and collect usage without submitting evaluation work."""
    started = time.monotonic() if started is None else started
    print(f"Job ID: {job_id} (resume with --job-id {job_id}; no new evaluation)", file=sys.stderr, flush=True)
    job = wait_job(client, job_id, timeout, poll_interval)
    evaluations = [request_data(client, "GET", f"/api/evaluations/{item['evaluation_id']}")
                   for item in job["items"] if item.get("evaluation_id")]
    usage = aggregate_usage(evaluations)
    usage_complete = len(evaluations) == job["total"]
    if not usage_complete:
        # A failed item may have consumed provider calls/tokens without a saved evaluation.
        usage = {key: None for key in usage}
    return {
        "job_id": job["id"], "status": job["status"], "provider": job["provider"], "is_demo": job["is_demo"],
        "total": job["total"], "succeeded": job["succeeded"], "failed": job["failed"],
        "manual_review_count": job["manual_review_count"],
        "duration_ms": int((time.monotonic() - started) * 1000), **usage, "usage_complete": usage_complete,
        "unknown_usage_means": "null means unknown, not zero",
    }


def run_group(client, group: str, *, force: bool = False, timeout: float = DEFAULT_TIMEOUT,
              poll_interval: float = 1) -> dict:
    started = time.monotonic()
    queued = request_data(client, "POST", "/api/evaluations", json={"group_id": group, "force": force})
    return read_job(client, queued["id"], timeout=timeout, poll_interval=poll_interval, started=started)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--group")
    selection.add_argument("--job-id", help="Wait for an existing job; never submits a new evaluation")
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="Maximum polling time in seconds (default: 2400)")
    args = parser.parse_args(argv)
    selected = args.group if args.group is not None else args.job_id
    if not selected.strip() or not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("group/job-id must be nonempty and timeout must be finite and positive")
    if args.job_id and args.force:
        parser.error("--force cannot be used with --job-id")
    if args.job_id and any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in args.job_id):
        parser.error("job-id must contain only letters, digits, hyphens or underscores")
    try:
        with httpx.Client(base_url=args.api_url, timeout=60) as client:
            result = (read_job(client, args.job_id, timeout=args.timeout) if args.job_id
                      else run_group(client, args.group, force=args.force, timeout=args.timeout))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["failed"] == 0 else 1
    except (BatchError, httpx.InvalidURL, ValueError):
        print("Batch failed: check API availability, selected group and server readiness. "
              "If a job ID was printed, use --job-id to resume waiting; do not submit the group again. "
              "Source content omitted.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
