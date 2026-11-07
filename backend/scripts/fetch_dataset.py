"""Download an authorized dataset URL without persisting or printing the URL.

Run from the repository root; the answer is saved as data/raw/<dataset_group_id>.json:
  python backend/scripts/fetch_dataset.py                  # group taken from the link
  python backend/scripts/fetch_dataset.py --group CONTROL  # same link, other group_id
"""
import argparse
import base64
import getpass
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/, for direct runs
from scripts import data_report  # noqa: E402


class DatasetRefused(Exception):
    """The answer was received but must not be saved. Messages never contain source data."""


def with_group(url: str, group: str) -> str:
    """Replace only the group_id parameter; every other byte of the signed link stays."""
    base, _, query = url.partition("?")
    kept = [part for part in query.split("&") if part and not part.startswith("group_id=")]
    return f"{base}?{'&'.join(kept + [f'group_id={group}'])}"


def download(url: str) -> tuple[bytes, dict]:
    with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=60) as response:
        raw = response.read()
    payload = json.loads(raw)
    if (not isinstance(payload, dict) or payload.get("isSuccess") is not True
            or not isinstance(payload.get("data"), dict)
            or not isinstance(payload["data"].get("records"), list)):
        raise DatasetRefused("invalid envelope")
    return raw, payload


def save(raw: bytes, payload: dict, requested_group: str | None) -> Path:
    group = payload["data"].get("dataset_group_id")
    if requested_group is not None and group != requested_group:
        raise DatasetRefused("the answer belongs to another group")
    try:
        destination = data_report.raw_dataset_path(group)
    except ValueError as exc:
        raise DatasetRefused("unsafe dataset_group_id in the answer") from exc
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(raw)
    return destination


def report_http_error(exc: HTTPError, url: str) -> None:
    try:
        body = json.loads(exc.read())
        error = body.get("error", body)
        code = error.get("code", "unknown")
        if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", code):
            print(f"Service error code: {code}", file=sys.stderr)
        if code == "ApiVersionInvalid":
            message = str(error.get("message", ""))
            for secret in parse_qs(urlsplit(url).query).get("sig", []):
                message = message.replace(secret, "[redacted]")
            message = re.sub(r"https?://\S+", "[URL omitted]", message)
            message = re.sub(r"[A-Za-z0-9_=-]{24,}", "[redacted]", message)
            print(message[:800], file=sys.stderr)
    except (ValueError, AttributeError, OSError):
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--encoded", action="store_true", help="hidden input is the link in base64")
    parser.add_argument("--group", help="replace group_id in the link, e.g. for the control set")
    args = parser.parse_args(argv)
    if args.group is not None and not data_report.GROUP_ID.fullmatch(args.group):
        print(data_report.GROUP_ID_RULE, file=sys.stderr)
        return 2
    url = getpass.getpass("Dataset URL (hidden): ")
    try:
        if args.encoded:
            url = base64.b64decode(url, validate=True).decode("utf-8")
        if args.group is not None:
            url = with_group(url, args.group)
        raw, payload = download(url)
        destination = save(raw, payload, args.group)
        shown = destination.relative_to(data_report.ROOT).as_posix()
        print(f"Saved {shown}: {len(payload['data']['records'])} records")
    except DatasetRefused as exc:
        print(f"Dataset refused: {exc}. Nothing saved; URL and response omitted.", file=sys.stderr)
        return 1
    except Exception as exc:
        # Network errors can contain the full signed URL or the response body.
        print(f"Dataset download failed ({type(exc).__name__}, HTTP {getattr(exc, 'code', 'n/a')}). URL and response omitted.", file=sys.stderr)
        if isinstance(exc, HTTPError):
            report_http_error(exc, url)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
