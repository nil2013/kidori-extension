"""kidori: 規格材の木取り図・加工指示図ジェネレータ。

CLI エントリポイント。pyproject.toml の [project.scripts] は
`kidori = "kidori:main"` を宣言しており、本モジュールの main() が呼び出される。
実体は cli.py の main() に委譲する（cli.py が終了コードを int で返し、
ここで sys.exit() に渡す）。
"""

from __future__ import annotations

import sys


def main() -> None:
    from kidori.cli import main as _main

    sys.exit(_main())
