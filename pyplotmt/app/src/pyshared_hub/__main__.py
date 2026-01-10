import sys

from PyShared_hub_ui import main as ui_main
from pyshared_hub import main as hub_main


if __name__ == "__main__":
    if "--hub" in sys.argv:
        hub_main()
    else:
        ui_main()
