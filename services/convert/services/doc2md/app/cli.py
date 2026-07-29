from __future__ import annotations

import argparse
import ipaddress

import uvicorn


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="doc2md-local")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9000)
    return parser


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    try:
        if not ipaddress.ip_address(args.host).is_loopback:
            raise SystemExit("doc2md-local only binds to a loopback IP address")
    except ValueError as error:
        raise SystemExit("--host must be a loopback IP address") from error
    uvicorn.run("app.main:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
