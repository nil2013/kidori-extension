"""render/dimension.py・render/svgdoc.py の単体テスト。

設計正本 .claude/logs/2026-07-22-design.md §10-6 の必須観点:
    - チェーン寸法: Σ区間 == 全長（許容差 1e-6）
    - 溝2本＋穴1個の抽出点数と順序
    - 0.01mm 未満の近接点デデュープ
    - 特徴なし部材 → 全長寸法のみ
    - svgdoc の基本テスト（生成 SVG が xml.etree でパース可能、座標変換の既知値）

conftest.py は Track A 所有のため使用しない。Part 等はこのファイル内で直接構築する。
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest

from kidori.model import Groove, Hole, Part, Stock
from kidori.render.dimension import (
    ChainSegment,
    DimensionStyle,
    build_chain_segments,
    compute_label_placement,
    dedupe_sorted,
    estimated_label_width,
    extract_chain_points,
    format_dimension_value,
    render_axis_chain,
    render_part_dimensions,
)
from kidori.render.svgdoc import (
    CoordTransform,
    SvgDocument,
    circle,
    g,
    line,
    path,
    pattern,
    rect,
    text,
)

SVG_NS = "{http://www.w3.org/2000/svg}"


# ---------------------------------------------------------------------------
# テスト用フィクスチャ相当（直接構築。conftest.py は使わない）
# ---------------------------------------------------------------------------


def make_sheet_stock(**overrides: object) -> Stock:
    base: dict[str, object] = dict(
        id="pine-18",
        label="パイン集成材18mm",
        kind="sheet",
        length=1820,
        width=910,
        thickness=18,
        price=6356,
    )
    base.update(overrides)
    return Stock(**base)  # type: ignore[arg-type]


def make_bar_stock(**overrides: object) -> Stock:
    base: dict[str, object] = dict(
        id="1x4-6f",
        label="1×4材 6F",
        kind="bar",
        length=1820,
        width=89,
        thickness=19,
        price=382,
    )
    base.update(overrides)
    return Stock(**base)  # type: ignore[arg-type]


def make_part(**overrides: object) -> Part:
    base: dict[str, object] = dict(
        id="side-0",
        label="側板0",
        qty=1,
        stock="pine-18",
        length=1985,
        width=200,
        rot=False,
        features=(),
    )
    base.update(overrides)
    return Part(**base)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# 対象点抽出（extract_chain_points）
# ---------------------------------------------------------------------------


class TestExtractChainPoints:
    def test_no_features_returns_only_bounds(self) -> None:
        """特徴なし部材 → 全長のみ（対象点は {0, L} / {0, W} だけ）。"""
        stock = make_sheet_stock()
        part = make_part(length=1985, width=200, features=())
        xs, ys = extract_chain_points(part, stock)
        assert xs == [0.0, 1985.0]
        assert ys == [0.0, 200.0]

    def test_two_grooves_and_one_hole_points_and_order(self) -> None:
        """溝2本（across/along 各1）＋穴1個の抽出点数・順序。"""
        stock = make_sheet_stock()
        features = (
            Groove(face="front", dir="across", pos=248, width=7, depth=6, end="through"),
            Groove(face="front", dir="along", pos=50, width=7, depth=6, end="through"),
            Hole(face="front", x=100, y=320, dia=4, depth=8),
        )
        part = make_part(length=1985, width=400, features=features)
        xs, ys = extract_chain_points(part, stock)
        # X軸: {0, 1985} ∪ {across溝中心 248} ∪ {穴x 100} → 昇順4点
        assert xs == [0.0, 100.0, 248.0, 1985.0]
        # Y軸: {0, 400} ∪ {along溝中心 50} ∪ {穴y 320} → 昇順4点
        assert ys == [0.0, 50.0, 320.0, 400.0]

    def test_dedupe_within_tolerance(self) -> None:
        """0.01mm 未満の近接点はデデュープされ1点に統合される。"""
        stock = make_sheet_stock()
        features = (
            Groove(face="front", dir="across", pos=248.0, width=7, depth=6, end="through"),
            Hole(face="front", x=248.005, y=100, dia=4, depth=8),  # 差 0.005mm
        )
        part = make_part(length=1985, width=200, features=features)
        xs, _ = extract_chain_points(part, stock)
        assert xs == [0.0, 248.0, 1985.0]

    def test_points_over_tolerance_kept_separate(self) -> None:
        """0.01mm を超える差の点は別点として残る（デデュープの境界確認）。"""
        stock = make_sheet_stock()
        features = (
            Groove(face="front", dir="across", pos=248.0, width=7, depth=6, end="through"),
            Hole(face="front", x=248.02, y=100, dia=4, depth=8),  # 差 0.02mm
        )
        part = make_part(length=1985, width=200, features=features)
        xs, _ = extract_chain_points(part, stock)
        assert xs == [0.0, 248.0, 248.02, 1985.0]

    def test_effective_width_used_for_bar_stock(self) -> None:
        """bar 部材では Y軸の全長が effective_width（=stock.width）になる。"""
        stock = make_bar_stock()  # width=89
        part = make_part(stock="1x4-6f", length=1820, width=None, features=())
        xs, ys = extract_chain_points(part, stock)
        assert xs == [0.0, 1820.0]
        assert ys == [0.0, 89.0]


class TestDedupeSorted:
    def test_merges_points_within_tolerance(self) -> None:
        assert dedupe_sorted([0.0, 0.005, 10.0]) == [0.0, 10.0]

    def test_keeps_points_over_tolerance(self) -> None:
        assert dedupe_sorted([0.0, 0.02, 10.0]) == [0.0, 0.02, 10.0]

    def test_sorts_unordered_input(self) -> None:
        assert dedupe_sorted([10.0, 0.0, 5.0]) == [0.0, 5.0, 10.0]


# ---------------------------------------------------------------------------
# チェーン化（build_chain_segments）と不変条件
# ---------------------------------------------------------------------------


class TestBuildChainSegments:
    def test_sum_equals_total_length_no_features(self) -> None:
        points = [0.0, 1985.0]
        segments = build_chain_segments(points)
        assert sum(seg.value for seg in segments) == pytest.approx(1985.0, abs=1e-6)

    def test_sum_equals_total_length_with_features(self) -> None:
        """Σ区間 == 全長（許容差 1e-6）。設計正本 §10-6 必須観点。"""
        stock = make_sheet_stock()
        features = (
            Groove(face="front", dir="across", pos=248, width=7, depth=6, end="through"),
            Groove(face="front", dir="across", pos=486, width=7, depth=6, end="through"),
            Hole(face="front", x=724, y=100, dia=4, depth=8),
        )
        part = make_part(length=1985, width=200, features=features)
        xs, _ = extract_chain_points(part, stock)
        segments = build_chain_segments(xs)
        total = xs[-1] - xs[0]
        assert total == pytest.approx(1985.0, abs=1e-6)
        assert sum(seg.value for seg in segments) == pytest.approx(total, abs=1e-6)

    def test_segment_values_are_ordered_intervals(self) -> None:
        segments = build_chain_segments([0.0, 100.0, 248.0, 1985.0])
        assert [seg.value for seg in segments] == pytest.approx([100.0, 148.0, 1737.0])
        assert [seg.label for seg in segments] == ["100", "148", "1737"]


class TestChainSegmentDataclass:
    def test_direct_construction(self) -> None:
        seg = ChainSegment(start=0.0, end=100.0, value=100.0, label="100")
        assert (seg.start, seg.end, seg.value, seg.label) == (0.0, 100.0, 100.0, "100")


# ---------------------------------------------------------------------------
# ラベル文字列化・被り回避（純粋計算部）
# ---------------------------------------------------------------------------


class TestFormatDimensionValue:
    def test_integer_value(self) -> None:
        assert format_dimension_value(600.0) == "600"

    def test_decimal_value_one_digit(self) -> None:
        assert format_dimension_value(248.5) == "248.5"

    def test_float_rounding_artifact_treated_as_integer(self) -> None:
        assert format_dimension_value(599.9999999998) == "600"

    def test_true_decimal_not_rounded_to_integer(self) -> None:
        assert format_dimension_value(0.4) == "0.4"


class TestEstimatedLabelWidth:
    def test_matches_formula(self) -> None:
        assert estimated_label_width("600", 10.0) == pytest.approx(0.62 * 10.0 * 3)


class TestComputeLabelPlacement:
    def test_wide_segment_is_normal_placement(self) -> None:
        segments = build_chain_segments([0.0, 100.0])
        placements = compute_label_placement(segments, scale=1.0, font_size=10.0)
        assert placements == [0]

    def test_narrow_segment_flipped_to_opposite_side(self) -> None:
        # 区間3mm・scale=1 → 描画幅3px。ラベル"3"の推定幅 = 0.62*10*1 = 6.2px > 3px → 狭区間
        segments = build_chain_segments([0.0, 3.0])
        placements = compute_label_placement(segments, scale=1.0, font_size=10.0)
        assert placements == [1]

    def test_consecutive_narrow_segments_stagger(self) -> None:
        segments = build_chain_segments([0.0, 3.0, 6.0, 9.0])
        placements = compute_label_placement(segments, scale=1.0, font_size=10.0)
        assert placements[0] == 1
        assert placements[1] != placements[0]
        assert placements[2] != placements[1]


# ---------------------------------------------------------------------------
# svgdoc.py の基本テスト
# ---------------------------------------------------------------------------


class TestSvgDocRendering:
    def test_document_is_parseable_xml(self) -> None:
        doc = SvgDocument(width=100, height=50)
        doc.add(rect(0, 0, 10, 10, fill="red"))
        doc.add(line(0, 0, 10, 10, stroke="black"))
        doc.add(circle(5, 5, 2))
        doc.add(text(1, 1, "テスト & <特殊文字>"))
        doc.add(g([path("M0 0 L10 10")]))
        rendered = doc.render()
        root = ET.fromstring(rendered)
        assert root.tag == f"{SVG_NS}svg"
        assert root.attrib["viewBox"] == "0 0 100 50"
        assert root.attrib["width"] == "100"
        assert root.attrib["height"] == "50"

    def test_pattern_element_renders_with_children(self) -> None:
        hatch = pattern(
            "hatch", 4, 4, children=[line(0, 0, 4, 4, stroke="gray")], patternUnits="userSpaceOnUse"
        )
        doc = SvgDocument(10, 10)
        doc.add(g([hatch]))
        root = ET.fromstring(doc.render())
        found = root.find(f".//{SVG_NS}pattern")
        assert found is not None
        assert found.attrib["id"] == "hatch"
        assert found.find(f"{SVG_NS}line") is not None

    def test_attr_escaping(self) -> None:
        el = rect(0, 0, 1, 1, data_label='He said "hi" & <bye>')
        rendered = el.render()
        assert "&quot;" in rendered
        assert "&amp;" in rendered
        assert "&lt;" in rendered
        # ハイフン変換: data_label -> data-label
        assert "data-label=" in rendered

    def test_text_escaping(self) -> None:
        el = text(0, 0, "A & B < C")
        rendered = el.render()
        assert "A &amp; B &lt; C" in rendered

    def test_float_attr_formatting_trims_trailing_zeros(self) -> None:
        el = rect(1.5, 2.0, 10.100, 3.0)
        rendered = el.render()
        assert 'x="1.5"' in rendered
        assert 'y="2"' in rendered
        assert 'width="10.1"' in rendered
        assert 'height="3"' in rendered


class TestCoordTransform:
    def test_point_flips_y_and_applies_scale_offset(self) -> None:
        tr = CoordTransform(scale=2.0, local_height=100.0, offset_x=10.0, offset_y=5.0)
        # ローカル (0, 0)（左下）→ SVG では最も下（offset_y + local_height*scale）
        sx, sy = tr.point(0.0, 0.0)
        assert (sx, sy) == pytest.approx((10.0, 5.0 + 100.0 * 2.0))
        # ローカル (0, 100)（左上）→ SVG では最も上（offset_y）
        sx2, sy2 = tr.point(0.0, 100.0)
        assert (sx2, sy2) == pytest.approx((10.0, 5.0))

    def test_length_scales_without_offset_or_flip(self) -> None:
        tr = CoordTransform(scale=0.5, local_height=100.0)
        assert tr.length(600.0) == pytest.approx(300.0)

    def test_rect_full_height_known_value(self) -> None:
        tr = CoordTransform(scale=1.0, local_height=89.0)
        sx, sy, sw, sh = tr.rect(0.0, 0.0, 600.0, 89.0)
        assert (sx, sy, sw, sh) == pytest.approx((0.0, 0.0, 600.0, 89.0))

    def test_rect_partial_height_known_value(self) -> None:
        tr = CoordTransform(scale=1.0, local_height=200.0)
        # ローカル矩形: 左下(0,0)、幅50・高さ80 → 上端 local y=80 → SVG y = 200-80 = 120
        sx, sy, sw, sh = tr.rect(0.0, 0.0, 50.0, 80.0)
        assert (sx, sy, sw, sh) == pytest.approx((0.0, 120.0, 50.0, 80.0))


# ---------------------------------------------------------------------------
# SVG 描画部（render_axis_chain / render_part_dimensions）のスモークテスト
# ---------------------------------------------------------------------------


class TestRenderAxisChain:
    def test_total_length_only_chain_produces_expected_elements(self) -> None:
        tr = CoordTransform(scale=1.0, local_height=200.0)
        style = DimensionStyle(font_size=8.0)
        el = render_axis_chain([0.0, 1985.0], tr, axis="x", level_index=0, style=style)
        doc = SvgDocument(2200, 400)
        doc.add(el)
        root = ET.fromstring(doc.render())
        lines = root.findall(f".//{SVG_NS}line")
        texts = root.findall(f".//{SVG_NS}text")
        assert len(texts) == 1
        assert texts[0].text == "1985"
        # 寸法線1 + ティック2 + 補助線(始点・終点)2 = 5
        assert len(lines) == 5


class TestRenderPartDimensions:
    def test_no_feature_part_has_total_only_two_axis_groups(self) -> None:
        stock = make_sheet_stock()
        part = make_part(length=1000, width=300, features=())
        tr = CoordTransform(scale=0.2, local_height=300.0)
        el = render_part_dimensions(part, stock, tr)
        # X軸グループ・Y軸グループの2つ
        assert len(el.children) == 2
        for axis_group in el.children:
            # 特徴なしなので各軸は全長寸法の1段のみ
            assert len(axis_group.children) == 1

    def test_with_features_renders_two_levels_and_is_parseable(self) -> None:
        stock = make_sheet_stock()
        features = (
            Groove(face="front", dir="across", pos=248, width=7, depth=6, end="through"),
            Hole(face="front", x=724, y=100, dia=4, depth=8),
        )
        part = make_part(length=1985, width=200, features=features)
        tr = CoordTransform(scale=0.3, local_height=200.0, offset_x=20.0, offset_y=20.0)
        el = render_part_dimensions(part, stock, tr)
        assert len(el.children) == 2
        for axis_group in el.children:
            # 特徴ありの軸(X)は内側チェーン+全長=2段、特徴なしの軸(Y)は全長のみ1段
            assert len(axis_group.children) in (1, 2)

        doc = SvgDocument(width=700, height=700)
        doc.add(el)
        root = ET.fromstring(doc.render())
        texts = root.findall(f".//{SVG_NS}text")
        assert len(texts) > 0
