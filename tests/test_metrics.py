"""kidori.metrics および packing.generate_plans のテスト。

設計正本（.claude/logs/2026-07-22-design.md）§8・§10-5・§10-7 に対応する。

pack1d.py は並行 rework 中（案C アルゴリズム差し替え）のため、本ファイルでは
generate_plans の統合テストで「grouped（案C）の具体的な配置」を前提にした
アサーションは書かない（プランが生成されること、seq の連番性・網羅性、
案の選択・クランプという pack_1d/pack_2d のインターフェース契約だけを検証する）。

metrics.py 単体の算出（歩留まり・カット回数・費用）のテストは、pack_1d/pack_2d を
経由せず Plan/StockUnit/Placement を直接組み立てて行う（アルゴリズムの詳細から
完全に切り離すため）。
"""

from __future__ import annotations

from kidori.metrics import _cut_count_2d, build_summary, summarize
from kidori.model import Meta, Part, Project, Settings, Stock
from kidori.packing import generate_plans
from kidori.packing.common import (
    PartInstance,
    Placement1D,
    Placement2D,
    Plan,
    StockUnit,
    cut_count_1d,
)

# ---------------------------------------------------------------------------
# テスト用ヘルパ（本ファイル内に閉じる。conftest.py には依存しない）
# ---------------------------------------------------------------------------


def make_bar_stock(
    stock_id: str = "bar-1",
    length: float = 1000.0,
    width: float = 89.0,
    thickness: float = 19.0,
    price: float | None = 100.0,
) -> Stock:
    return Stock(
        id=stock_id,
        label=f"テスト bar {stock_id}",
        kind="bar",
        length=length,
        width=width,
        thickness=thickness,
        price=price,
    )


def make_sheet_stock(
    stock_id: str = "sheet-1",
    length: float = 1000.0,
    width: float = 500.0,
    thickness: float = 18.0,
    price: float | None = 200.0,
) -> Stock:
    return Stock(
        id=stock_id,
        label=f"テスト sheet {stock_id}",
        kind="sheet",
        length=length,
        width=width,
        thickness=thickness,
        price=price,
    )


def make_bar_part(part_id: str, length: float, qty: int = 1, stock_id: str = "bar-1") -> Part:
    return Part(id=part_id, label=f"部材 {part_id}", qty=qty, stock=stock_id, length=length)


def make_sheet_part(
    part_id: str,
    length: float,
    width: float,
    qty: int = 1,
    stock_id: str = "sheet-1",
    rot: bool = True,
) -> Part:
    return Part(
        id=part_id,
        label=f"部材 {part_id}",
        qty=qty,
        stock=stock_id,
        length=length,
        width=width,
        rot=rot,
    )


def inst(part: Part, index: int = 1) -> PartInstance:
    return PartInstance(part=part, index=index)


def make_project(
    stocks: tuple[Stock, ...],
    parts: tuple[Part, ...],
    settings: Settings | None = None,
) -> Project:
    return Project(
        meta=Meta(project="テスト", units="mm", schema_version="0.2"),
        settings=settings or Settings(),
        stocks=stocks,
        parts=parts,
    )


# ---------------------------------------------------------------------------
# §10-5: 1D カット回数（summarize 経由での plumbing 確認。式自体は
# packing.common.cut_count_1d が単一の実装であり、ここでは再実装しない）
# ---------------------------------------------------------------------------


def test_1d_cut_count_n1_edge_trim_positive_is_2():
    """n=1, edgeTrim>0 → 2回（先頭の捨て切り + 末尾切り）。"""
    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=None)
    stock = make_bar_stock(length=1000.0)
    part = make_bar_part("p", length=500.0)
    placement = Placement1D(instance=inst(part), start=settings.edge_trim)
    unit = StockUnit(stock=stock, index=1, placements=[placement])
    plan = Plan(id="A", method_1d="ffd", method_2d="bssf", units=[unit], seq={"p#1": 1})
    project = make_project((stock,), (part,), settings)

    result = summarize(plan, project)

    assert result["stocks"][0]["cutCount"] == 2
    # cut_count_1d 単体でも同じ値であること（summarize が独自式を実装していないことの確認）。
    assert cut_count_1d([placement], stock, settings) == 2


def test_1d_cut_count_n1_edge_trim_zero_end_equals_length_is_0():
    """n=1, edgeTrim=0, かつ部材右端==L → 0回（先頭・末尾いずれも省略）。"""
    settings = Settings(kerf=3.0, edge_trim=0.0, candidates=3, selected_plan=None)
    stock = make_bar_stock(length=500.0)
    part = make_bar_part("p", length=500.0)
    placement = Placement1D(instance=inst(part), start=0.0)
    unit = StockUnit(stock=stock, index=1, placements=[placement])
    plan = Plan(id="A", method_1d="ffd", method_2d="bssf", units=[unit], seq={"p#1": 1})
    project = make_project((stock,), (part,), settings)

    result = summarize(plan, project)

    assert result["stocks"][0]["cutCount"] == 0
    assert result["stocks"][0]["units"][0]["remnant"] == 0.0


def test_1d_cut_count_n3_full_case():
    """n=3 のフルケース: (1) + (n-1)=2 + (1) = 4回。"""
    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=None)
    stock = make_bar_stock(length=1000.0)
    p1 = make_bar_part("p1", length=100.0)
    p2 = make_bar_part("p2", length=150.0)
    p3 = make_bar_part("p3", length=200.0)
    placements = [
        Placement1D(instance=inst(p1), start=5.0),  # edgeTrim
        Placement1D(instance=inst(p2), start=5.0 + 100.0 + 3.0),  # 108
        Placement1D(instance=inst(p3), start=5.0 + 100.0 + 3.0 + 150.0 + 3.0),  # 261
    ]
    unit = StockUnit(stock=stock, index=1, placements=placements)
    plan = Plan(
        id="A",
        method_1d="ffd",
        method_2d="bssf",
        units=[unit],
        seq={"p1#1": 1, "p2#1": 2, "p3#1": 3},
    )
    project = make_project((stock,), (p1, p2, p3), settings)

    result = summarize(plan, project)

    assert result["stocks"][0]["cutCount"] == 4
    # 手計算: remnant = L - edgeTrim - E, E = 261 + 200 = 461
    assert result["stocks"][0]["units"][0]["remnant"] == 1000.0 - 5.0 - 461.0


# ---------------------------------------------------------------------------
# §10-5: 2D カット回数（縁カット有無 + 窓境界に載らない辺の減算）
# ---------------------------------------------------------------------------


def test_2d_cut_count_no_edge_trim_full_coverage_is_0():
    """edgeTrim=0、部材が生材そのものを全面被覆 → 縁カット0・全辺境界一致で0回。"""
    settings = Settings(kerf=3.0, edge_trim=0.0)
    stock = make_sheet_stock(length=100.0, width=100.0)
    part = make_sheet_part("p", length=100.0, width=100.0)
    placement = Placement2D(instance=inst(part), x=0.0, y=0.0, rotated=False)
    unit = StockUnit(stock=stock, index=1, placements=[placement])

    assert _cut_count_2d(unit, stock, settings) == 0


def test_2d_cut_count_edge_trim_full_window_coverage_is_4():
    """edgeTrim=5、部材が使用可能窓 100×100 をちょうど埋める → 縁カット4回のみ。"""
    settings = Settings(kerf=3.0, edge_trim=5.0)
    stock = make_sheet_stock(length=110.0, width=110.0)  # Lu=Wu=100
    part = make_sheet_part("p", length=100.0, width=100.0)
    placement = Placement2D(instance=inst(part), x=5.0, y=5.0, rotated=False)
    unit = StockUnit(stock=stock, index=1, placements=[placement])

    assert _cut_count_2d(unit, stock, settings) == 4


def test_2d_cut_count_two_parts_partial_coverage():
    """2部材、それぞれ1辺だけ境界に載らない → 縁カット4 + 1 + 1 = 6回。"""
    settings = Settings(kerf=3.0, edge_trim=5.0)
    stock = make_sheet_stock(length=210.0, width=110.0)  # Lu=200, Wu=100
    part_a = make_sheet_part("a", length=97.0, width=100.0, rot=False)
    part_b = make_sheet_part("b", length=100.0, width=100.0, rot=False)
    # A: left=5(境界)/bottom=5(境界)/top=105(境界)、right=102(境界205に届かず=未載)。
    placement_a = Placement2D(instance=inst(part_a), x=5.0, y=5.0, rotated=False)
    # B: right=205(境界)/bottom=5/top=105(境界)、left=105(境界5でも205でもない=未載)。
    placement_b = Placement2D(instance=inst(part_b), x=105.0, y=5.0, rotated=False)
    unit = StockUnit(stock=stock, index=1, placements=[placement_a, placement_b])

    assert _cut_count_2d(unit, stock, settings) == 4 + 1 + 1


def test_2d_cut_count_rotated_extent_is_swapped():
    """rotated=True の部材は実寸 width×length として境界判定される（extent 入替の検証）。

    stock: length=210, width=110, edgeTrim=5 → Lu=200, Wu=100。
    part: length=100, width=200（sheet 部材の width は必須。ここでは検証層を経由
    しない直接構築のため物理的整合チェックは適用されない）。
    rotated=True で x=5,y=5 に配置すると、正しく extent を入れ替えれば
    実占有は width(200)×length(100) となり、使用可能窓 200×100 をちょうど
    埋めて縁カット4回のみ（cutCount=4）になる。
    もし実装が rotated を無視して (length, width) のまま評価すると、
    実占有は 100×200 と誤って判定され、右辺・上辺がいずれも境界からずれて
    cutCount=6 になってしまう（本テストはこの取り違えを検出する）。
    """
    settings = Settings(kerf=3.0, edge_trim=5.0)
    stock = make_sheet_stock(length=210.0, width=110.0)
    part = make_sheet_part("p", length=100.0, width=200.0, rot=True)
    placement = Placement2D(instance=inst(part), x=5.0, y=5.0, rotated=True)
    unit = StockUnit(stock=stock, index=1, placements=[placement])

    assert _cut_count_2d(unit, stock, settings) == 4


# ---------------------------------------------------------------------------
# §10-7: 歩留まり（手計算一致）・体積ベース totals.yield・費用欠落
# ---------------------------------------------------------------------------


def test_bar_yield_matches_hand_calculation():
    """bar の歩留まり = Σ部材長 ÷ (本数×L)。"""
    settings = Settings(kerf=3.0, edge_trim=5.0)
    stock = make_bar_stock(length=1000.0, price=None)
    p1 = make_bar_part("p1", length=300.0)
    p2 = make_bar_part("p2", length=400.0)
    placements = [
        Placement1D(instance=inst(p1), start=5.0),
        Placement1D(instance=inst(p2), start=5.0 + 300.0 + 3.0),
    ]
    unit = StockUnit(stock=stock, index=1, placements=placements)
    plan = Plan(
        id="A", method_1d="ffd", method_2d="bssf", units=[unit],
        seq={"p1#1": 1, "p2#1": 2},
    )
    project = make_project((stock,), (p1, p2), settings)

    result = summarize(plan, project)

    expected_yield = (300.0 + 400.0) / (1 * 1000.0)
    assert result["stocks"][0]["yield"] == expected_yield


def test_sheet_yield_matches_hand_calculation():
    """sheet の歩留まり = Σ部材面積 ÷ (枚数×L×W)。"""
    settings = Settings(kerf=3.0, edge_trim=5.0)
    stock = make_sheet_stock(length=1000.0, width=500.0, price=None)
    part = make_sheet_part("p", length=500.0, width=200.0)
    placement = Placement2D(instance=inst(part), x=5.0, y=5.0, rotated=False)
    unit = StockUnit(stock=stock, index=1, placements=[placement])
    plan = Plan(id="A", method_1d="ffd", method_2d="bssf", units=[unit], seq={"p#1": 1})
    project = make_project((stock,), (part,), settings)

    result = summarize(plan, project)

    expected_yield = (500.0 * 200.0) / (1 * 1000.0 * 500.0)
    assert result["stocks"][0]["yield"] == expected_yield


def test_totals_yield_is_volume_based_bar_and_sheet_mixed():
    """bar+sheet 混在時の totals.yield は体積ベース（bar の部材幅は stock.width）。"""
    settings = Settings(kerf=3.0, edge_trim=5.0)
    bar_stock = make_bar_stock(length=1000.0, width=89.0, thickness=19.0, price=100.0)
    sheet_stock = make_sheet_stock(length=1000.0, width=500.0, thickness=18.0, price=200.0)

    bp1 = make_bar_part("bp1", length=300.0, stock_id=bar_stock.id)
    bp2 = make_bar_part("bp2", length=400.0, stock_id=bar_stock.id)
    sp = make_sheet_part("sp", length=500.0, width=200.0, stock_id=sheet_stock.id)

    bar_placements = [
        Placement1D(instance=inst(bp1), start=5.0),
        Placement1D(instance=inst(bp2), start=5.0 + 300.0 + 3.0),
    ]
    bar_unit = StockUnit(stock=bar_stock, index=1, placements=bar_placements)
    sheet_placement = Placement2D(instance=inst(sp), x=5.0, y=5.0, rotated=False)
    sheet_unit = StockUnit(stock=sheet_stock, index=1, placements=[sheet_placement])

    plan = Plan(
        id="A",
        method_1d="ffd",
        method_2d="bssf",
        units=[bar_unit, sheet_unit],
        seq={"bp1#1": 1, "bp2#1": 2, "sp#1": 3},
    )
    project = make_project((bar_stock, sheet_stock), (bp1, bp2, sp), settings)

    result = summarize(plan, project)

    vol_num = (300.0 * 89.0 * 19.0) + (400.0 * 89.0 * 19.0) + (500.0 * 200.0 * 18.0)
    vol_den = (1000.0 * 89.0 * 19.0) + (1000.0 * 500.0 * 18.0)
    expected_totals_yield = vol_num / vol_den

    assert result["totals"]["yield"] == expected_totals_yield


def test_cost_null_and_cost_complete_false_when_all_prices_missing():
    """使用する全規格に price が無ければ cost: null / costComplete: false。"""
    settings = Settings(kerf=3.0, edge_trim=5.0)
    stock = make_bar_stock(length=1000.0, price=None)
    part = make_bar_part("p", length=300.0)
    placement = Placement1D(instance=inst(part), start=5.0)
    unit = StockUnit(stock=stock, index=1, placements=[placement])
    plan = Plan(id="A", method_1d="ffd", method_2d="bssf", units=[unit], seq={"p#1": 1})
    project = make_project((stock,), (part,), settings)

    result = summarize(plan, project)

    assert result["totals"]["cost"] is None
    assert result["totals"]["costComplete"] is False
    assert result["stocks"][0]["unitPrice"] is None
    assert result["stocks"][0]["subtotal"] is None


def test_cost_partial_price_missing_sets_cost_complete_false_but_cost_not_null():
    """一部の規格にのみ price がある場合、cost はその規格の小計和・costComplete=false。"""
    settings = Settings(kerf=3.0, edge_trim=5.0)
    bar_stock = make_bar_stock(length=1000.0, price=100.0)
    sheet_stock = make_sheet_stock(length=1000.0, width=500.0, price=None)

    bp = make_bar_part("bp", length=300.0, stock_id=bar_stock.id)
    sp = make_sheet_part("sp", length=500.0, width=200.0, stock_id=sheet_stock.id)

    bar_unit = StockUnit(
        stock=bar_stock, index=1, placements=[Placement1D(instance=inst(bp), start=5.0)]
    )
    sheet_unit = StockUnit(
        stock=sheet_stock,
        index=1,
        placements=[Placement2D(instance=inst(sp), x=5.0, y=5.0, rotated=False)],
    )
    plan = Plan(
        id="A", method_1d="ffd", method_2d="bssf",
        units=[bar_unit, sheet_unit], seq={"bp#1": 1, "sp#1": 2},
    )
    project = make_project((bar_stock, sheet_stock), (bp, sp), settings)

    result = summarize(plan, project)

    assert result["totals"]["cost"] == 1 * 100.0
    assert result["totals"]["costComplete"] is False


def test_cost_complete_true_when_all_priced():
    """使用する全規格に price がある場合、costComplete=true・cost=全小計和。"""
    settings = Settings(kerf=3.0, edge_trim=5.0)
    bar_stock = make_bar_stock(length=1000.0, price=100.0)
    sheet_stock = make_sheet_stock(length=1000.0, width=500.0, price=200.0)

    bp = make_bar_part("bp", length=300.0, stock_id=bar_stock.id)
    sp = make_sheet_part("sp", length=500.0, width=200.0, stock_id=sheet_stock.id)

    bar_unit = StockUnit(
        stock=bar_stock, index=1, placements=[Placement1D(instance=inst(bp), start=5.0)]
    )
    sheet_unit = StockUnit(
        stock=sheet_stock,
        index=1,
        placements=[Placement2D(instance=inst(sp), x=5.0, y=5.0, rotated=False)],
    )
    plan = Plan(
        id="A", method_1d="ffd", method_2d="bssf",
        units=[bar_unit, sheet_unit], seq={"bp#1": 1, "sp#1": 2},
    )
    project = make_project((bar_stock, sheet_stock), (bp, sp), settings)

    result = summarize(plan, project)

    assert result["totals"]["costComplete"] is True
    assert result["totals"]["cost"] == (1 * 100.0) + (1 * 200.0)
    assert result["totals"]["stockCounts"] == {bar_stock.id: 1, sheet_stock.id: 1}


def test_method_label_prefixes_2d_method_with_maxrects():
    """method.2d は "maxrects-" 接頭辞つきで出力される（Plan.method_2d="bssf" → "maxrects-bssf"）。"""
    settings = Settings()
    stock = make_bar_stock()
    part = make_bar_part("p", length=300.0)
    unit = StockUnit(
        stock=stock, index=1, placements=[Placement1D(instance=inst(part), start=5.0)]
    )
    plan = Plan(id="B", method_1d="bfd", method_2d="baf", units=[unit], seq={"p#1": 1})
    project = make_project((stock,), (part,), settings)

    result = summarize(plan, project)

    assert result["method"] == {"1d": "bfd", "2d": "maxrects-baf"}
    assert result["id"] == "B"


# ---------------------------------------------------------------------------
# build_summary
# ---------------------------------------------------------------------------


def test_build_summary_uses_caller_supplied_generated_at():
    """generated_at は呼び出し側が渡した文字列をそのまま使う（現在時刻取得はしない）。"""
    settings = Settings(selected_plan="A")
    stock = make_bar_stock()
    part = make_bar_part("p", length=300.0)
    project = make_project((stock,), (part,), settings)

    plans = generate_plans(project)
    summaries = [summarize(p, project) for p in plans]
    result = build_summary(summaries, project, generated_at="2026-07-22T17:30:00+09:00")

    assert result["generatedAt"] == "2026-07-22T17:30:00+09:00"
    assert result["schemaVersion"] == "0.2"
    assert result["project"] == "テスト"
    assert result["selectedPlan"] == "A"
    assert result["plans"] == summaries


# ---------------------------------------------------------------------------
# generate_plans の統合テスト
# ---------------------------------------------------------------------------


def _integration_project(settings: Settings) -> Project:
    """qty 展開・複数 stock 混在を確認するための統合テスト用 Project。"""
    bar_stock = make_bar_stock(stock_id="bar-1", length=2000.0, price=100.0)
    sheet_stock = make_sheet_stock(stock_id="sheet-1", length=1000.0, width=500.0, price=200.0)

    part_a = make_bar_part("partA", length=300.0, qty=3, stock_id="bar-1")
    part_b = make_sheet_part("partB", length=400.0, width=200.0, qty=2, stock_id="sheet-1")
    part_c = make_bar_part("partC", length=250.0, qty=1, stock_id="bar-1")

    return make_project(
        (bar_stock, sheet_stock), (part_a, part_b, part_c), settings
    )


def test_generate_plans_qty_expansion_and_seq_covers_all_instances():
    """qty 展開: 全 PartInstance が seq に過不足なく現れ、1..N の連番になる。"""
    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=None)
    project = _integration_project(settings)

    plans = generate_plans(project)

    assert len(plans) == 3
    expected_instance_ids = {
        "partA#1", "partA#2", "partA#3",
        "partB#1", "partB#2",
        "partC#1",
    }
    for plan in plans:
        assert set(plan.seq.keys()) == expected_instance_ids
        assert sorted(plan.seq.values()) == list(range(1, 7))


def test_generate_plans_units_ordered_by_stock_declaration_order():
    """Plan.units は stocks の宣言順（bar-1 が先、sheet-1 が後）に整列される。"""
    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=1, selected_plan=None)
    project = _integration_project(settings)

    plans = generate_plans(project)
    plan = plans[0]

    stock_id_sequence = [unit.stock.id for unit in plan.units]
    # bar-1 のユニットが全て sheet-1 のユニットより前に来ること。
    last_bar_index = max(
        i for i, sid in enumerate(stock_id_sequence) if sid == "bar-1"
    )
    first_sheet_index = min(
        i for i, sid in enumerate(stock_id_sequence) if sid == "sheet-1"
    )
    assert last_bar_index < first_sheet_index


def test_generate_plans_candidates_clamp_upper_bound():
    """candidates=5（範囲外）は 3 にクランプされ、A/B/C の3案が生成される。"""
    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=5, selected_plan=None)
    project = _integration_project(settings)

    plans = generate_plans(project)

    assert [p.id for p in plans] == ["A", "B", "C"]


def test_generate_plans_candidates_clamp_lower_bound():
    """candidates=0（範囲外）は 1 にクランプされ、A のみ生成される。"""
    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=0, selected_plan=None)
    project = _integration_project(settings)

    plans = generate_plans(project)

    assert [p.id for p in plans] == ["A"]


def test_generate_plans_candidates_1_returns_only_plan_a():
    """candidates=1 → A のみ1件。"""
    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=1, selected_plan=None)
    project = _integration_project(settings)

    plans = generate_plans(project)

    assert len(plans) == 1
    assert plans[0].id == "A"
    assert plans[0].method_1d == "ffd"


def test_generate_plans_selected_plan_filters_to_single_plan():
    """selected_plan="B" → B のみ1件（method は BFD/BAF のペア）。"""
    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan="B")
    project = _integration_project(settings)

    plans = generate_plans(project)

    assert len(plans) == 1
    assert plans[0].id == "B"
    assert plans[0].method_1d == "bfd"
    assert plans[0].method_2d == "baf"


def test_generate_plans_is_deterministic_across_calls():
    """同一 project から2回生成しても seq の対応が完全一致する（決定性）。"""
    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=None)
    project = _integration_project(settings)

    plans_1 = generate_plans(project)
    plans_2 = generate_plans(project)

    assert [p.seq for p in plans_1] == [p.seq for p in plans_2]
    for p1, p2 in zip(plans_1, plans_2):
        stocks_1 = [(u.stock.id, u.index) for u in p1.units]
        stocks_2 = [(u.stock.id, u.index) for u in p2.units]
        assert stocks_1 == stocks_2
