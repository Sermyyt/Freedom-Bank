"""Download an authorized dataset URL without persisting or printing the URL."""
import getpass
import base64
import json
import re
from pathlib import Path
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit


def main():
    url = getpass.getpass("Dataset URL (hidden): ")
    try:
        if "--encoded" in sys.argv:
            url = base64.b64decode(url, validate=True).decode("utf-8")
        with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=60) as response:
            raw = response.read()
        payload = json.loads(raw)
        if payload.get("isSuccess") is not True or not isinstance(payload.get("data", {}).get("records"), list):
            raise ValueError("Invalid envelope")
        destination = Path(__file__).resolve().parents[2] / "data/raw/DEV.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw)
        print(f"Saved data/raw/DEV.json: {len(payload['data']['records'])} records")
    except Exception as exc:
        # Network errors can contain the full signed URL or the response body.
        print(f"Dataset download failed ({type(exc).__name__}, HTTP {getattr(exc, 'code', 'n/a')}). URL and response omitted.", file=sys.stderr)
        if isinstance(exc, HTTPError):
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
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
