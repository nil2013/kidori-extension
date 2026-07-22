"""render.cutplan / render.partcard の単体テスト（設計正本 §10-9）。

conftest.py は Track A（loader/schema）の所有物のため、本ファイルは一切依存せず
Meta/Settings/Stock/Part/Groove/Hole/PartInstance/Placement/StockUnit/Plan を
すべて自前で構築する（pack1d/pack2d の実行結果に依存しない。pack1d は並行
rework 中のため、生成結果と結合したテストは Phase 3 の E2E に委ねる）。

検証観点:
    1. xml.etree.ElementTree でパース可能なこと。
    2. 部材矩形（data-role="part-rect"）個数・配置番号ラベル（data-role="seq-label"）
       個数が、Plan の配置数と一致すること。
    3. 加工指示図の溝（data-role="groove"）・穴（data-role="hole"）要素数が
       part.features の内訳と一致すること。
    4. ヘッダ文字列に歩留まり・【採用】の有無が反映されること。
    5. bar パネル・sheet パネルの両方でパース・個数検証が通ること。
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

from kidori.model import Groove, Hole, Meta, Part, Project, Settings, Stock
from kidori.packing.common import PartInstance, Placement1D, Placement2D, Plan, StockUnit
from kidori.render.cutplan import circled_number, render_cutplan
from kidori.render.partcard import render_partcard

SVG_NS = "{http://www.w3.org/2000/svg}"


def _find_by_role(root: ET.Element, role: str, tag: str | None = None) -> list[ET.Element]:
    """data-role 属性が一致する要素を列挙する（tag 指定時はさらに絞り込む）。"""

    result = []
    for el in root.iter():
        if tag is not None and el.tag != f"{SVG_NS}{tag}":
            continue
        if el.attrib.get("data-role") == role:
            result.append(el)
    return result


def _header_texts(root: ET.Element) -> list[str]:
    return ["".join(el.itertext()) for el in _find_by_role(root, "header", "text")]


# ---------------------------------------------------------------------------
# fixture ヘルパ
# ---------------------------------------------------------------------------


def make_project(settings: Settings, stocks: tuple[Stock, ...], parts: tuple[Part, ...]) -> Project:
    return Project(
        meta=Meta(project="テスト棚", units="mm", schema_version="0.2"),
        settings=settings,
        stocks=stocks,
        parts=parts,
    )


def make_bar_plan_and_project(selected_plan: str | None) -> tuple[Plan, Project]:
    """bar 原材1本に部材3個（shelf-0#1, shelf-0#2, shelf-1#1）を配置した Plan。"""

    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=selected_plan)
    stock = Stock(id="1x4-6f", label="1×4材 6F", kind="bar", length=1820, width=89, thickness=19, price=382)
    part_a = Part(id="shelf-0", label="棚板0", qty=2, stock="1x4-6f", length=600)
    part_b = Part(id="shelf-1", label="棚板1", qty=1, stock="1x4-6f", length=500)
    project = make_project(settings, (stock,), (part_a, part_b))

    inst_a1 = PartInstance(part=part_a, index=1)
    inst_a2 = PartInstance(part=part_a, index=2)
    inst_b1 = PartInstance(part=part_b, index=1)

    placements = [
        Placement1D(instance=inst_a1, start=5.0),
        Placement1D(instance=inst_a2, start=608.0),
        Placement1D(instance=inst_b1, start=1211.0),
    ]
    unit = StockUnit(stock=stock, index=1, placements=placements)
    seq = {
        inst_a1.instance_id: 1,
        inst_a2.instance_id: 2,
        inst_b1.instance_id: 3,
    }
    plan = Plan(id="A", method_1d="ffd", method_2d="bssf", units=[unit], seq=seq)
    return plan, project


def make_bar_summary() -> dict:
    return {
        "id": "A",
        "method": {"1d": "ffd", "2d": "bssf"},
        "stocks": [
            {
                "stockId": "1x4-6f", "kind": "bar", "count": 1,
                "unitPrice": 382, "subtotal": 382,
                "yield": 0.9374, "cutCount": 4,
                "units": [],
            }
        ],
        "totals": {
            "cost": 382, "costComplete": True,
            "yield": 0.9374, "cutCount": 4,
            "stockCounts": {"1x4-6f": 1},
        },
    }


def make_sheet_plan_and_project(selected_plan: str | None) -> tuple[Plan, Project]:
    """sheet 原材1枚に部材2個（回転あり・なし各1）を配置した Plan。"""

    settings = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=selected_plan)
    stock = Stock(id="ply-12", label="合板12mm", kind="sheet", length=910, width=605, thickness=12, price=3000)
    part = Part(id="side-0", label="側板0", qty=2, stock="ply-12", length=300, width=200, rot=True)
    project = make_project(settings, (stock,), (part,))

    inst1 = PartInstance(part=part, index=1)
    inst2 = PartInstance(part=part, index=2)

    placements = [
        Placement2D(instance=inst1, x=5.0, y=5.0, rotated=False),
        Placement2D(instance=inst2, x=308.0, y=5.0, rotated=True),
    ]
    unit = StockUnit(stock=stock, index=1, placements=placements)
    seq = {inst1.instance_id: 1, inst2.instance_id: 2}
    plan = Plan(id="B", method_1d="bfd", method_2d="baf", units=[unit], seq=seq)
    return plan, project


def make_sheet_summary() -> dict:
    return {
        "id": "B",
        "method": {"1d": "bfd", "2d": "baf"},
        "stocks": [
            {
                "stockId": "ply-12", "kind": "sheet", "count": 1,
                "unitPrice": 3000, "subtotal": 3000,
                "yield": 0.217, "cutCount": 8,
                "units": [],
            }
        ],
        "totals": {
            "cost": 3000, "costComplete": True,
            "yield": 0.217, "cutCount": 8,
            "stockCounts": {"ply-12": 1},
        },
    }


def make_part_with_features() -> tuple[Part, Stock]:
    stock = Stock(id="pine-18", label="パイン集成材18mm", kind="sheet", length=1820, width=910, thickness=18, price=6356)
    part = Part(
        id="side-0",
        label="側板0",
        qty=1,
        stock="pine-18",
        length=1200,
        width=200,
        rot=False,
        features=(
            Groove(face="front", dir="across", pos=300, width=7, depth=6, end="through"),
            Groove(face="back", dir="along", pos=100, width=5, depth=4, end="stopped", from_=50, to=400),
            Hole(face="front", x=200, y=150, dia=4, depth=8),
            Hole(face="front", x=1000, y=50, dia=6, depth=None),
        ),
    )
    return part, stock


# ---------------------------------------------------------------------------
# render_cutplan
# ---------------------------------------------------------------------------


def test_cutplan_bar_panel_parses_and_counts_match():
    plan, project = make_bar_plan_and_project(selected_plan="A")
    svg_text = render_cutplan(plan, project, make_bar_summary())

    root = ET.fromstring(svg_text)  # パース可能なこと

    part_rects = _find_by_role(root, "part-rect", "rect")
    seq_labels = _find_by_role(root, "seq-label", "text")
    part_dims = _find_by_role(root, "part-dims", "text")

    assert len(part_rects) == 3
    assert len(seq_labels) == 3
    # 3枚とも矩形が十分大きいスケールになっているため寸法ラベルも出る想定。
    assert len(part_dims) == 3

    # SPECS §6: 各部材矩形に部材 ID・ラベル・寸法を記入。
    # ラベル行は「① shelf-0 棚板0」形式で id と label を併記する。
    label_texts = ["".join(el.itertext()) for el in seq_labels]
    assert sum(1 for t in label_texts if "shelf-0" in t and "棚板0" in t) == 2
    assert sum(1 for t in label_texts if "shelf-1" in t and "棚板1" in t) == 1

    # kerf 帯: 3配置の隣接ペアは2組。
    kerf_bands = _find_by_role(root, "kerf-band", "rect")
    assert len(kerf_bands) == 2

    # edgeTrim 域: 1D は先端・末尾の2枚のみ。
    edge_trim_rects = _find_by_role(root, "edge-trim", "rect")
    assert len(edge_trim_rects) == 2

    # 残長（端材）: stock.length(1820) - edge_trim(5) - E(1711) = 104mm > 0。
    remnants = _find_by_role(root, "remnant", "rect")
    assert len(remnants) == 1


def test_cutplan_header_shows_yield_and_adopted_marker_when_selected():
    plan, project = make_bar_plan_and_project(selected_plan="A")
    svg_text = render_cutplan(plan, project, make_bar_summary())
    root = ET.fromstring(svg_text)

    headers = _header_texts(root)
    assert len(headers) == 1
    header = headers[0]
    assert "歩留まり" in header
    assert "案A" in header
    assert "【採用】" in header


def test_cutplan_header_has_no_adopted_marker_when_not_selected():
    plan, project = make_bar_plan_and_project(selected_plan=None)
    svg_text = render_cutplan(plan, project, make_bar_summary())
    root = ET.fromstring(svg_text)

    header = _header_texts(root)[0]
    assert "歩留まり" in header
    assert "【採用】" not in header


def test_cutplan_header_marker_absent_for_other_plan():
    plan, project = make_bar_plan_and_project(selected_plan="B")  # 別案が採用
    svg_text = render_cutplan(plan, project, make_bar_summary())
    root = ET.fromstring(svg_text)

    header = _header_texts(root)[0]
    assert "【採用】" not in header


def test_cutplan_sheet_panel_parses_and_counts_match():
    plan, project = make_sheet_plan_and_project(selected_plan="B")
    svg_text = render_cutplan(plan, project, make_sheet_summary())

    root = ET.fromstring(svg_text)

    part_rects = _find_by_role(root, "part-rect", "rect")
    seq_labels = _find_by_role(root, "seq-label", "text")

    assert len(part_rects) == 2
    assert len(seq_labels) == 2

    # SPECS §6: 部材矩形に part.label（側板0）が併記されること。
    label_texts = ["".join(el.itertext()) for el in seq_labels]
    assert sum(1 for t in label_texts if "side-0" in t and "側板0" in t) == 2

    # 2D の kerf 帯: 部材ごとに右・上の2本 = 4本。
    kerf_bands = _find_by_role(root, "kerf-band", "rect")
    assert len(kerf_bands) == 4

    # 2D の edgeTrim 域: 長さ方向2枚 + 幅方向2枚 = 4枚。
    edge_trim_rects = _find_by_role(root, "edge-trim", "rect")
    assert len(edge_trim_rects) == 4

    header = _header_texts(root)[0]
    assert "歩留まり" in header
    assert "【採用】" in header


# ---------------------------------------------------------------------------
# render_partcard
# ---------------------------------------------------------------------------


def test_partcard_feature_counts_match():
    part, stock = make_part_with_features()
    svg_text = render_partcard(part, stock)

    root = ET.fromstring(svg_text)  # パース可能なこと

    grooves = _find_by_role(root, "groove")
    holes = _find_by_role(root, "hole")
    hole_marks = _find_by_role(root, "hole-center-mark", "line")

    assert len(grooves) == 2
    assert len(holes) == 2
    # 貫通穴は1個（dia=6, depth=None）のため十字マークは2本（横・縦）。
    assert len(hole_marks) == 2

    headers = _header_texts(root)
    assert len(headers) == 1
    assert "side-0" in headers[0]
    assert "側板0" in headers[0]
    assert "配置" not in headers[0]


def test_partcard_header_shows_seq_labels_when_selected_plan_present():
    part, stock = make_part_with_features()
    svg_text = render_partcard(part, stock, seq_labels=[1, 3], plan_id="A")

    root = ET.fromstring(svg_text)
    headers = _header_texts(root)

    assert len(headers) == 2
    assert "配置: 案A" in headers[1]
    assert "①" in headers[1]
    assert "③" in headers[1]


def test_partcard_groove_face_distinguishes_front_back():
    part, stock = make_part_with_features()
    svg_text = render_partcard(part, stock)
    root = ET.fromstring(svg_text)

    grooves = _find_by_role(root, "groove")
    faces = {el.attrib.get("data-face") for el in grooves}
    assert faces == {"front", "back"}


# ---------------------------------------------------------------------------
# circled_number
# ---------------------------------------------------------------------------


def test_circled_number_boundary():
    assert circled_number(1) == "①"
    assert circled_number(20) == "⑳"
    assert circled_number(21) == "(21)"


# ---------------------------------------------------------------------------
# フォント指定（PNG 変換時の日本語判読性）
# ---------------------------------------------------------------------------


def test_svg_root_has_cjk_font_family():
    """ルート svg に CJK 対応の font-family が付与されること
    （cairosvg での PNG 変換時に日本語が豆腐化しないための担保）。"""

    plan, project = make_bar_plan_and_project(selected_plan=None)
    for svg_text in (
        render_cutplan(plan, project, make_bar_summary()),
        render_partcard(*make_part_with_features()),
    ):
        root = ET.fromstring(svg_text)
        font_family = root.attrib.get("font-family", "")
        assert font_family, "ルート svg に font-family がない"
        assert "Noto Sans CJK JP" in font_family
        assert "sans-serif" in font_family
