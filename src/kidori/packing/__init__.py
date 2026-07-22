"""kidori.packing パッケージ。

1D/2D 割付エンジンの公開インターフェースを提供する。

案 ID と (1D割付方式, 2D割付方式) の固定ペア定義（PLAN_METHODS）に加え、
`generate_plans(project) -> list[Plan]` を提供する（設計正本 §1・§3・§4・§8）。
"""

from __future__ import annotations

from kidori.model import Project
from kidori.packing.common import PartInstance, Plan, StockUnit
from kidori.packing.pack1d import pack_1d
from kidori.packing.pack2d import pack_2d

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


def _expand_instances_by_stock(project: Project) -> dict[str, list[PartInstance]]:
    """qty 展開: 全 part を PartInstance(part, 1..qty) に展開し、stock id ごとに束ねる。

    parts[].stock が明示バインドのため、パッキングは stock id ごとに独立に
    実行できる（設計正本 §1）。ここでは project.parts の宣言順に処理するが、
    戻り値は「stock id → その stock を使う全 PartInstance」の対応表であり、
    stocks 自体の宣言順の適用は `_build_plan` 側（project.stocks を辿る側）で行う。
    """
    by_stock: dict[str, list[PartInstance]] = {}
    for part in project.parts:
        for index in range(1, part.qty + 1):
            by_stock.setdefault(part.stock, []).append(PartInstance(part=part, index=index))
    return by_stock


def _build_plan(
    plan_id: str,
    method_1d: str,
    method_2d: str,
    project: Project,
    instances_by_stock: dict[str, list[PartInstance]],
) -> Plan:
    """1案ぶんの Plan を組み立てる（stock ごとに pack_1d / pack_2d へ委譲）。

    Plan.units は「stocks の宣言順 → index 順」に整列する。pack_1d / pack_2d は
    それぞれ1 stock 分だけを呼び出すため、project.stocks を宣言順に走査して
    その戻り値（index=1始まりで既に整列済み）を単純に連結するだけで、この整列
    規則を満たす（設計正本 §1）。

    Plan.seq は units→placements の順（1D は start 昇順、2D は (y, x) 昇順）で
    1始まりの通し番号を振る。pack_1d/pack_2d は既にその順で placements を確定
    させて返す（pack1d.pack_1d は挿入順=start昇順、pack2d.pack_2d は明示的に
    (y, x) でソート済み）ため、ここでは単純に列挙して番号を振るだけでよい。
    """
    units: list[StockUnit] = []
    for stock in project.stocks:
        instances = instances_by_stock.get(stock.id)
        if not instances:
            continue
        if stock.kind == "bar":
            stock_units = pack_1d(instances, stock, project.settings, method_1d)
        else:  # sheet
            stock_units = pack_2d(instances, stock, project.settings, method_2d)
        units.extend(stock_units)

    seq: dict[str, int] = {}
    n = 0
    for unit in units:
        for placement in unit.placements:
            n += 1
            seq[placement.instance.instance_id] = n

    return Plan(id=plan_id, method_1d=method_1d, method_2d=method_2d, units=units, seq=seq)


def generate_plans(project: Project) -> list[Plan]:
    """割付案 A/B/C を生成する（設計正本 §1・§3・§4・§8）。

    - qty 展開: PartInstance(part, 1..qty)。
    - stock id ごとに部材を分け、Stock.kind に応じ pack_1d / pack_2d に委譲する
      （方式は PLAN_METHODS の固定ペア）。
    - settings.candidates を 1〜3 にクランプした件数の案を生成する。
    - settings.selected_plan が設定されている場合は、クランプ後の候補一覧の
      うち該当する案 ID の Plan のみを生成する（他案のアルゴリズムは実行しない）。
      selected_plan がクランプ後の範囲外の場合は空リストを返す（loader の意味
      検証層でこの組み合わせは既に error として弾かれる前提であり、本関数は
      その防御を重ねて行わない）。

    Args:
        project: 検証済みの Project（loader.load_project の戻り値を想定）。

    Returns:
        生成された Plan のリスト（候補順、最大3件）。
    """
    instances_by_stock = _expand_instances_by_stock(project)

    clamped = max(1, min(3, project.settings.candidates))
    methods = PLAN_METHODS[:clamped]

    selected = project.settings.selected_plan
    if selected is not None:
        methods = [m for m in methods if m[0] == selected]

    return [
        _build_plan(plan_id, method_1d, method_2d, project, instances_by_stock)
        for plan_id, method_1d, method_2d in methods
    ]
