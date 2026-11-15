import argparse
import importlib
import sys

_COMMAND_MODULES = ("lunarnav.cli_ephem", "lunarnav.cli_terrain", "lunarnav.spacecraft")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="lunarnav",
        description="Lunar Landing Site Navigator - data pipeline and reference tools",
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>")
    for name in _COMMAND_MODULES:
        try:
            module = importlib.import_module(name)
        except ModuleNotFoundError as exc:
            if exc.name != name:
                raise
            continue
        module.register(sub)
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    return args.func(args) or 0


if __name__ == "__main__":
    sys.exit(main())
