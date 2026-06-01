"""
SentinelNMS backend — PyInstaller entry point.

Built into a standalone binary (nms-backend / nms-backend.exe) that
bundles Python + all deps with no external framework dependencies.

Usage (Electron calls this):
    nms-backend --host 127.0.0.1 --port 8765 --log-level warning

Dev usage (runs directly without building):
    python backend_entry.py --port 8765
"""
import sys
import os
import argparse

# When frozen by PyInstaller, sys._MEIPASS is the extraction directory.
# api/ and core/ are bundled there via --add-data, so we add it to sys.path
# so that `import api.main` works.
if getattr(sys, 'frozen', False):
    sys.path.insert(0, sys._MEIPASS)
else:
    # Dev mode: project root is next to this file
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    parser = argparse.ArgumentParser(description='SentinelNMS Backend')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--log-level', default='warning')
    args, _ = parser.parse_known_args()

    import uvicorn
    uvicorn.run(
        'api.main:app',
        host=args.host,
        port=args.port,
        log_level=args.log_level,
    )


if __name__ == '__main__':
    main()
