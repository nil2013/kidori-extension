"""kidori.packing パッケージ。

1D/2D 割付エンジンの公開インターフェースを提供する。

Phase 0 時点では、案 ID と (1D割付方式, 2D割付方式) の固定ペア定義のみを置く。
`generate_plans(project) -> list[Plan]` は Phase 2 以降
（Track B: packing/pack1d.py、Track C: packing/pack2d.py が完成した後）に
このモジュールへ追加される。ここでは将来の追加を妨げないよう、
PLAN_METHODS のみをモジュールレベル定数として公開する。
"""

from __future__ import annotations

# 案 ID と (1D割付方式, 2D割付方式) の固定ペア（設計正本 §1・§3・§4）。
# 1案 = 1D方式 + 2D方式の固定ペアであり、bar/sheet が混在するプロジェクトでも
# 案 ID は横断で1系列とする。
#   A: FFD          + MaxRects-BSSF（歩留まり重視の定番）
#   B: BFD          + MaxRects-BAF （残り容量の評価軸を変えた対抗案）
#   C: 同種グループ化 + MaxRects-BL （カット線を揃え作業性を重視）
PLAN_METHODS: list[tuple[str, str, str]] = [
    ("A", "ffd", "bssf"),
    ("B", "bfd", "baf"),
    ("C", "grouped", "bl"),
]

# TODO(Phase 2以降): ここに generate_plans(project: Project) -> list[Plan] を実装する。
# packing.pack1d.pack_1d と packing.pack2d.pack_2d が揃った後、PLAN_METHODS を
# 辿って stock.kind ごとに委譲し、settings.candidates（1〜3にクランプ）件、
# settings.selected_plan 指定時は該当1件のみを返す。
