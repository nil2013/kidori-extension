"""割付案（Plan）から summary.json 相当のメトリクスを算出する（設計正本 §8）。

公開 API:
    - `summarize(plan, project) -> dict`: Plan 1件ぶんの summary.json ``plans[]`` 要素。
    - `build_summary(plans_summaries, project, generated_at) -> dict`: summary.json 全体。

`generated_at` は呼び出し側（build.py）が ISO 文字列で渡す設計とする
（本モジュールが `datetime.now()` 等で現在時刻を取得すると、テストの決定性が
損なわれるため）。

歩留まり・費用・カット回数の算出式は設計正本 §8「算出定義（厳密）」に厳密に従う。
1D のカット回数計算は `packing.common.cut_count_1d` を必ず再利用し、本モジュールで
独自の 1D カット回数式を再実装しない。
"""

from __future__ import annotations

from kidori.model import Project, Settings, Stock, effective_width
from kidori.packing.common import (
    EPS,
    Placement2D,
    Plan,
    StockUnit,
    cut_count_1d,
)

# ---------------------------------------------------------------------------
# 2D カット回数（設計正本 §8）
# ---------------------------------------------------------------------------


def _placement_extent(placement: Placement2D, stock: Stock) -> tuple[float, float]:
    """配置された部材の実寸フットプリント (x方向長さ, y方向長さ) を実座標基準で返す。

    Placement2D.rotated のドキュメント（packing/common.py）の規約:
    「rotated=True の場合、実寸は width×length になる」に対応する。
    rotated=False なら (part.length, effective_width)、
    rotated=True なら (effective_width, part.length) を返す
    （x方向・y方向を入れ替える）。

    テスト用フックとして直接呼び出し可能（アンダースコアはモジュール内部実装で
    あることを示すのみで、非公開を意図しない。pack2d.py の `_pack_2d_sheets` と
    同じ位置づけ）。
    """
    part = placement.instance.part
    w = effective_width(part, stock)
    if placement.rotated:
        return w, part.length
    return part.length, w


def _cut_count_2d(unit: StockUnit, stock: Stock, settings: Settings) -> int:
    """1枚（1 StockUnit）あたりの2D割付カット回数を返す（設計正本 §8）。

    定義:
        縁の切り出しカット 4回（edgeTrim>0 のとき）
        + 各部材ごとの「使用可能窓の境界に載っていない辺」の数の合計。

    使用可能窓は実座標で [edgeTrim, stock.length-edgeTrim] × [edgeTrim, stock.width-edgeTrim]。
    部材の辺がこの境界に（EPS 許容で）載っている場合、その辺は縁カット
    （edgeTrim>0 のとき）または生端容認（edgeTrim==0 のとき）でカバーされるため
    追加のカットを要しない。載っていない辺は+1回のカットとして数える。

    **共線カットの1パス統合は行わない**（自由配置では複数部材の切断線がちょうど
    一直線に並ぶ保証がなく、統合の可否判定が別途必要になるため。ギロチン制約
    対応時に再定義する。設計正本 §8 末尾に対応する注記）。

    rotated 部材の実寸（実座標での占有幅・奥行き）は `_placement_extent` で
    正しく入れ替えて評価する（rotated=True なら実寸は width×length）。

    Args:
        unit: 対象の StockUnit（sheet 原材1枚ぶん）。
        stock: unit.stock と同一の原材定義（呼び出し側が unit.stock を渡してもよい）。
        settings: kerf・edgeTrim を含む設定。

    Returns:
        この1枚に対するカット回数。
    """
    edge_trim = settings.edge_trim
    edge_cut = 4 if edge_trim > EPS else 0

    left_boundary = edge_trim
    right_boundary = stock.length - edge_trim
    bottom_boundary = edge_trim
    top_boundary = stock.width - edge_trim

    uncovered = 0
    for placement in unit.placements:
        ex, ey = _placement_extent(placement, stock)
        on_boundary = (
            abs(placement.x - left_boundary) <= EPS,
            abs((placement.x + ex) - right_boundary) <= EPS,
            abs(placement.y - bottom_boundary) <= EPS,
            abs((placement.y + ey) - top_boundary) <= EPS,
        )
        uncovered += sum(1 for on in on_boundary if not on)

    return edge_cut + uncovered


# ---------------------------------------------------------------------------
# summarize: Plan 1件ぶんの summary.json plans[] 要素
# ---------------------------------------------------------------------------


def summarize(plan: Plan, project: Project) -> dict:
    """Plan 1件ぶんの summary.json ``plans[]`` 要素を組み立てる（設計正本 §8）。

    stocks[] は project.stocks の宣言順のうち、この plan で実際に使用された
    stock id のみを列挙する。各要素の ``units`` は unit.index 昇順、
    ``placements`` は 1D なら start 昇順、2D なら (y, x) 昇順（pack_1d/pack_2d が
    既にその順で確定させて返すため、ここでは並べ替えのみ行い新たな順序規則は
    導入しない）。

    算出定義（設計正本 §8「算出定義（厳密）」）:
        - 歩留まり: bar = Σ部材長 ÷ (本数×L)。sheet = Σ部材面積 ÷ (枚数×L×W)。
          分母は原材全体（有効長ではない）。
        - totals.yield は体積ベース:
          Σ(部材の length×width×原材thickness) ÷ Σ(原材 L×W×t)。
          bar の部材幅は stock.width（effective_width）を用いる。
        - 費用: subtotal = count×price。totals.cost は price のある規格の
          小計和、costComplete = 全使用規格に price があるか。price が
          1つも無ければ cost: null（costComplete は False のまま）。
        - カット回数: 1D は `packing.common.cut_count_1d`（1本ごとに算出して
          合算）。2D は `_cut_count_2d`（1枚ごとに算出して合算）。

    Args:
        plan: 対象の割付案（`packing.generate_plans` の戻り値の1要素）。
        project: この plan の元になった Project（settings・stocks・price を参照）。

    Returns:
        summary.json の ``plans[]`` 1要素に相当する dict。
    """

    settings = project.settings

    units_by_stock: dict[str, list[StockUnit]] = {}
    for unit in plan.units:
        units_by_stock.setdefault(unit.stock.id, []).append(unit)
    for units in units_by_stock.values():
        units.sort(key=lambda u: u.index)

    stocks_out: list[dict] = []
    stock_counts: dict[str, int] = {}
    cost_total = 0.0
    cost_any_priced = False
    cost_all_priced = True
    vol_num_total = 0.0
    vol_den_total = 0.0
    cut_count_total = 0

    for stock in project.stocks:
        units = units_by_stock.get(stock.id)
        if not units:
            continue

        count = len(units)
        stock_counts[stock.id] = count

        if stock.price is not None:
            subtotal: float | None = count * stock.price
            cost_total += subtotal
            cost_any_priced = True
        else:
            subtotal = None
            cost_all_priced = False

        if stock.kind == "bar":
            group_len_sum = 0.0
            group_cut_count = 0
            units_out: list[dict] = []
            for unit in units:
                placements = sorted(unit.placements, key=lambda p: p.start)

                len_sum = sum(p.instance.part.length for p in placements)
                group_len_sum += len_sum
                group_cut_count += cut_count_1d(placements, stock, settings)

                if placements:
                    end_edge = placements[-1].start + placements[-1].instance.part.length
                else:
                    end_edge = settings.edge_trim
                remnant = stock.length - settings.edge_trim - end_edge

                placements_out = [
                    {
                        "part": p.instance.part.id,
                        "instance": p.instance.index,
                        "seq": plan.seq[p.instance.instance_id],
                        "start": p.start,
                        "length": p.instance.part.length,
                    }
                    for p in placements
                ]
                units_out.append(
                    {"index": unit.index, "placements": placements_out, "remnant": remnant}
                )

                vol_den_total += stock.length * stock.width * stock.thickness
                for p in placements:
                    part = p.instance.part
                    vol_num_total += part.length * effective_width(part, stock) * stock.thickness

            denom = count * stock.length
            group_yield = (group_len_sum / denom) if denom > 0 else 0.0
            cut_count_total += group_cut_count

            stocks_out.append(
                {
                    "stockId": stock.id,
                    "kind": "bar",
                    "count": count,
                    "unitPrice": stock.price,
                    "subtotal": subtotal,
                    "yield": group_yield,
                    "cutCount": group_cut_count,
                    "units": units_out,
                }
            )
        else:  # sheet
            group_area_sum = 0.0
            group_cut_count = 0
            units_out = []
            for unit in units:
                placements = sorted(unit.placements, key=lambda p: (p.y, p.x))

                area_sum = sum(
                    p.instance.part.length * effective_width(p.instance.part, stock)
                    for p in placements
                )
                group_area_sum += area_sum
                group_cut_count += _cut_count_2d(unit, stock, settings)

                placements_out = []
                for p in placements:
                    part = p.instance.part
                    placements_out.append(
                        {
                            "part": part.id,
                            "instance": p.instance.index,
                            "seq": plan.seq[p.instance.instance_id],
                            "x": p.x,
                            "y": p.y,
                            "rotated": p.rotated,
                            "length": part.length,
                            "width": effective_width(part, stock),
                        }
                    )
                units_out.append({"index": unit.index, "placements": placements_out})

                vol_den_total += stock.length * stock.width * stock.thickness
                for p in placements:
                    part = p.instance.part
                    vol_num_total += part.length * effective_width(part, stock) * stock.thickness

            denom = count * stock.length * stock.width
            group_yield = (group_area_sum / denom) if denom > 0 else 0.0
            cut_count_total += group_cut_count

            stocks_out.append(
                {
                    "stockId": stock.id,
                    "kind": "sheet",
                    "count": count,
                    "unitPrice": stock.price,
                    "subtotal": subtotal,
                    "yield": group_yield,
                    "cutCount": group_cut_count,
                    "units": units_out,
                }
            )

    totals_yield = (vol_num_total / vol_den_total) if vol_den_total > 0 else 0.0

    return {
        "id": plan.id,
        "method": {"1d": plan.method_1d, "2d": f"maxrects-{plan.method_2d}"},
        "stocks": stocks_out,
        "totals": {
            "cost": cost_total if cost_any_priced else None,
            "costComplete": cost_all_priced,
            "yield": totals_yield,
            "cutCount": cut_count_total,
            "stockCounts": stock_counts,
        },
    }


# ---------------------------------------------------------------------------
# build_summary: summary.json 全体
# ---------------------------------------------------------------------------


def build_summary(
    plans_summaries: list[dict],
    project: Project,
    generated_at: str,
) -> dict:
    """summary.json 全体を組み立てる（設計正本 §8）。

    Args:
        plans_summaries: `summarize()` の戻り値のリスト（生成した各 Plan ぶん）。
        project: 対象の Project（meta・settings を参照）。
        generated_at: ISO 形式の生成時刻文字列。呼び出し側（build.py）が
            現在時刻を渡す（本関数は時刻取得を行わない。テスト決定性のため）。

    Returns:
        summary.json のトップレベル dict。
    """

    return {
        "schemaVersion": project.meta.schema_version,
        "generatedAt": generated_at,
        "project": project.meta.project,
        "selectedPlan": project.settings.selected_plan,
        "plans": plans_summaries,
    }
