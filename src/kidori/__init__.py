"""kidori: 規格材の木取り図・加工指示図ジェネレータ。

CLI エントリポイント。pyproject.toml の [project.scripts] は
`kidori = "kidori:main"` を宣言しており、本モジュールの main() が呼び出される。
"""


def main() -> None:
    # TODO(Phase 3): cli.py 実装後、`from kidori.cli import main as _main; _main()`
    # へ委譲する。現時点では cli.py が未実装のためプレースホルダとする。
    raise SystemExit("kidori: cli は未実装（Phase 3）")
