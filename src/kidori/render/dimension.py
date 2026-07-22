"""チェーン寸法エンジン（設計正本 .claude/logs/2026-07-22-design.md §6 準拠）。

加工指示図（parts/<部材ID>.svg、render/partcard.py、Phase 2）が使う、部材の
チェーン寸法線（手描き図面互換の 248/486/724 式表記）を計算・描画する。

モジュールは2層に分離する:
    - 純粋計算部（外部依存なし、単体テスト対象）:
      :func:`extract_chain_points`、:func:`dedupe_sorted`、:func:`build_chain_segments`、
      :func:`format_dimension_value`、:func:`estimated_label_width`、
      :func:`compute_label_placement`
    - SVG 描画部（render/svgdoc.py に依存）:
      :func:`render_axis_chain`、:func:`render_part_dimensions`、:class:`DimensionStyle`

設計正本 §6 の要点（再掲）:
    1. 対象点抽出: X軸 = {0, L} ∪ {across溝の中心 pos} ∪ {穴のx}。
       Y軸 = {0, W} ∪ {along溝の中心 pos} ∪ {穴のy}（溝は中心基準）。
    2. 許容差 0.01mm でデデュープ → 昇順ソート → 隣接差分を区間値としてチェーン化。
       区間値は整数なら整数表記、小数は1桁。
    3. Xチェーンは部材下側第1段、全長寸法は第2段（さらに外側）。Yチェーンは左側に同様の2段。
       対象点が {0, L} のみの軸は全長寸法1段だけ。累進寸法はv1では描かない。
    4. 文字被り回避: 推定文字幅（0.62×font_size×文字数）が区間描画幅を超えるとき、
       その区間ラベルは寸法線の反対側にずらす。隣接する狭区間が連続する場合は交互スタガ。
    5. 端点は寸法補助線＋45°ティック。
    6. 不変条件: 各チェーンの区間合計 == 全長。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from kidori.model import Groove, Hole, Part, Stock, effective_width
from kidori.render.svgdoc import CoordTransform, Element, g, line, text

#: 対象点デデュープの許容差（mm）。設計正本 §6-2。
DEDUPE_TOLERANCE = 0.01

#: 区間値が「整数とみなせる」ための許容差（mm）。浮動小数演算の丸め誤差を吸収する。
#: DEDUPE_TOLERANCE より1桁小さく取り、意図的な 0.x mm 端数（デデュープを免れた値）を
#: 誤って整数表記に丸めないようにする。
INT_LABEL_TOLERANCE = 1e-6

#: 推定文字幅の係数（設計正本 §6-4: 0.62 × font_size × 文字数）。
CHAR_WIDTH_RATIO = 0.62


# ---------------------------------------------------------------------------
# 純粋計算部
# ---------------------------------------------------------------------------


def extract_chain_points(part: Part, stock: Stock) -> tuple[list[float], list[float]]:
    """部材の寸法チェーン対象点を軸ごとに抽出する（設計正本 §6-1）。

    - X軸: ``{0, part.length}`` ∪ ``{dir="across" の groove.pos}`` ∪ ``{hole.x}``
    - Y軸: ``{0, effective_width(part, stock)}`` ∪ ``{dir="along" の groove.pos}`` ∪ ``{hole.y}``

    溝は幅方向・長さ方向とも中心（``pos``）を対象点とする。正本の ``pos`` 定義が
    溝中心であるため、手描き図面の 248/486/724 のような中心基準の表記と一致する。

    戻り値は軸ごとに 0.01mm 許容差でデデュープ・昇順ソート済み（:func:`dedupe_sorted` 適用済み）。

    Args:
        part: 対象の部材。
        stock: part.stock が参照する原材（effective_width の算出に使う）。

    Returns:
        ``(xs, ys)``: X軸・Y軸それぞれの対象点リスト（mm、昇順・デデュープ済み）。
    """

    width = effective_width(part, stock)
    xs: list[float] = [0.0, float(part.length)]
    ys: list[float] = [0.0, float(width)]

    for feature in part.features:
        if isinstance(feature, Groove):
            if feature.dir == "across":
                xs.append(float(feature.pos))
            else:  # "along"
                ys.append(float(feature.pos))
        elif isinstance(feature, Hole):
            xs.append(float(feature.x))
            ys.append(float(feature.y))

    return dedupe_sorted(xs), dedupe_sorted(ys)


def dedupe_sorted(points: list[float], tolerance: float = DEDUPE_TOLERANCE) -> list[float]:
    """点列を昇順ソートし、隣接差分が ``tolerance`` 以下の点を1点に統合する。

    Args:
        points: 対象点（mm）。順不同・重複可。
        tolerance: デデュープ許容差（mm）。設計正本 §6-2 の 0.01mm。

    Returns:
        昇順ソート・デデュープ済みの点列。
    """

    ordered = sorted(points)
    result: list[float] = []
    for p in ordered:
        if result and abs(p - result[-1]) <= tolerance:
            continue
        result.append(p)
    return result


@dataclass(frozen=True)
class ChainSegment:
    """チェーン寸法の1区間。

    Attributes:
        start: 区間始点（mm、対象点の値）。
        end: 区間終点（mm、対象点の値）。
        value: 区間値 ``end - start``（mm）。
        label: 表示用文字列（:func:`format_dimension_value` 適用済み）。
    """

    start: float
    end: float
    value: float
    label: str


def build_chain_segments(points: list[float]) -> list[ChainSegment]:
    """昇順ソート・デデュープ済みの点列から、隣接差分によるチェーン区間列を作る。

    Args:
        points: :func:`dedupe_sorted` 済みの点列（要素2個以上を想定）。

    Returns:
        区間列。``sum(seg.value for seg in result) == points[-1] - points[0]`` が
        常に成り立つ（設計正本 §6-6 の不変条件）。
    """

    segments: list[ChainSegment] = []
    for a, b in zip(points[:-1], points[1:]):
        value = b - a
        segments.append(ChainSegment(start=a, end=b, value=value, label=format_dimension_value(value)))
    return segments


def format_dimension_value(value: float, int_tolerance: float = INT_LABEL_TOLERANCE) -> str:
    """寸法値を表示用文字列に整形する（設計正本 §6-2: 整数は整数表記、小数は1桁）。

    Args:
        value: 区間値（mm）。
        int_tolerance: 整数とみなす許容差（mm）。

    Returns:
        整形済み文字列（例: ``"600"``、``"248.5"``）。
    """

    rounded = round(value)
    if abs(value - rounded) <= int_tolerance:
        return str(int(rounded))
    return f"{value:.1f}"


def estimated_label_width(label: str, font_size: float, ratio: float = CHAR_WIDTH_RATIO) -> float:
    """ラベルの推定描画幅（px）を返す（設計正本 §6-4: 0.62 × font_size × 文字数）。"""

    return ratio * font_size * len(label)


def compute_label_placement(
    segments: list[ChainSegment], scale: float, font_size: float
) -> list[int]:
    """各区間のラベル配置レベルを決定する（設計正本 §6-4 の最低限規則）。

    - 区間の描画幅（``value * scale``）が推定文字幅以上の「通常区間」は 0（寸法線上）。
    - 推定文字幅が描画幅を超える「狭区間」は寸法線の反対側へ逃がす（1）。
    - 狭区間が連続する場合は、さらに反対側の中で交互にスタガする（1 と 2 を交互）。

    戻り値のレベルの意味づけ（描画側で使用）:
        0 = 通常位置（寸法線のすぐ内側）
        1 = 反対側・スタガA
        2 = 反対側・スタガB

    Args:
        segments: :func:`build_chain_segments` の戻り値。
        scale: mm から px への倍率（区間描画幅の算出に使う）。
        font_size: フォントサイズ（px）。

    Returns:
        ``segments`` と同じ長さの配置レベル列。
    """

    placements: list[int] = []
    prev_narrow = False
    stagger = 0
    for seg in segments:
        drawn_width = seg.value * scale
        narrow = estimated_label_width(seg.label, font_size) > drawn_width
        if not narrow:
            placements.append(0)
            prev_narrow = False
            stagger = 0
            continue
        if prev_narrow:
            stagger = 2 if stagger == 1 else 1
        else:
            stagger = 1
        placements.append(stagger)
        prev_narrow = True
    return placements


# ---------------------------------------------------------------------------
# SVG 描画部
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DimensionStyle:
    """チェーン寸法線の描画スタイル定数。

    Attributes:
        font_size: ラベルのフォントサイズ（px）。
        first_gap: 部材輪郭から第1段の寸法線までの距離（px）。
        line_gap: 段と段の間隔（px）。
        tick_size: 45°ティックの一辺相当の長さ（px）。
        stroke: 寸法線・ティックの色。
        ext_stroke: 寸法補助線（引出線）の色。
        stroke_width: 寸法線の線幅（px）。
    """

    font_size: float = 10.0
    first_gap: float = 10.0
    line_gap: float = 14.0
    tick_size: float = 4.0
    stroke: str = "#333333"
    ext_stroke: str = "#999999"
    stroke_width: float = 1.0


def _tick(x: float, y: float, size: float, stroke: str) -> Element:
    """45°ティックマーク（寸法線端点の短い斜線）を生成する。"""

    half = size / 2
    return line(x - half, y + half, x + half, y - half, stroke=stroke, stroke_width=1)


def render_axis_chain(
    points: list[float],
    transform: CoordTransform,
    *,
    axis: Literal["x", "y"],
    level_index: int,
    style: DimensionStyle = DimensionStyle(),
) -> Element:
    """1軸・1段分のチェーン寸法（寸法線・ティック・ラベル・補助線）を ``<g>`` として描画する。

    Args:
        points: この段で連結する対象点列（昇順・デデュープ済み。2点なら区間1個＝全長寸法）。
        transform: 部材ローカル座標 → SVG 座標の変換。
        axis: ``"x"`` は部材下側（Y方向に補助線を伸ばす）、``"y"`` は部材左側
            （X方向に補助線を伸ばす）に描画する。
        level_index: 段番号（0始まり）。0 が部材輪郭に最も近い段。
        style: 描画スタイル。

    Returns:
        寸法線一式をまとめた ``<g>`` 要素。
    """

    segments = build_chain_segments(points)
    placements = compute_label_placement(segments, transform.scale, style.font_size)
    elements: list[Element] = []
    offset = style.first_gap + level_index * style.line_gap

    if axis == "x":
        # 部材下側: 寸法線は local y=0 の直下（SVG では下方向 = offset_y + local_height*scale より下）。
        base_x, base_y = transform.point(0.0, 0.0)
        y_line = base_y + offset
        for seg, placement in zip(segments, placements):
            x1, _ = transform.point(seg.start, 0.0)
            x2, _ = transform.point(seg.end, 0.0)
            elements.append(line(x1, y_line, x2, y_line, stroke=style.stroke, stroke_width=style.stroke_width))
            elements.append(_tick(x1, y_line, style.tick_size, style.stroke))
            elements.append(_tick(x2, y_line, style.tick_size, style.stroke))
            mid_x = (x1 + x2) / 2
            label_y = y_line - 3 if placement == 0 else y_line + style.font_size + 2 + (4 if placement == 2 else 0)
            elements.append(
                text(mid_x, label_y, seg.label, font_size=style.font_size, text_anchor="middle")
            )
        for p in points:
            px, py = transform.point(p, 0.0)
            elements.append(line(px, py, px, y_line, stroke=style.ext_stroke, stroke_width=0.5))
    else:
        # 部材左側: 寸法線は local x=0 の直左。
        base_x, base_y = transform.point(0.0, 0.0)
        x_line = base_x - offset
        for seg, placement in zip(segments, placements):
            _, y1 = transform.point(0.0, seg.start)
            _, y2 = transform.point(0.0, seg.end)
            elements.append(line(x_line, y1, x_line, y2, stroke=style.stroke, stroke_width=style.stroke_width))
            elements.append(_tick(x_line, y1, style.tick_size, style.stroke))
            elements.append(_tick(x_line, y2, style.tick_size, style.stroke))
            mid_y = (y1 + y2) / 2
            label_x = x_line - 3 if placement == 0 else x_line - style.font_size - 2 - (4 if placement == 2 else 0)
            elements.append(
                text(
                    label_x,
                    mid_y,
                    seg.label,
                    font_size=style.font_size,
                    text_anchor="end",
                    dominant_baseline="middle",
                )
            )
        for p in points:
            px, py = transform.point(0.0, p)
            elements.append(line(px, py, x_line, py, stroke=style.ext_stroke, stroke_width=0.5))

    return g(elements)


def render_part_dimensions(
    part: Part,
    stock: Stock,
    transform: CoordTransform,
    style: DimensionStyle = DimensionStyle(),
) -> Element:
    """部材のX軸・Y軸チェーン寸法一式を ``<g>`` として描画する（render/partcard.py から呼ぶ想定）。

    設計正本 §6-3: Xチェーンは部材下側の第1段＋全長寸法の第2段（対象点が {0,L} のみなら
    全長寸法1段だけ）。Yチェーンは左側に同様の構成。

    Args:
        part: 対象の部材。
        stock: part.stock が参照する原材。
        transform: 部材ローカル座標 → SVG 座標の変換（``local_height`` は
            ``effective_width(part, stock)`` と一致させること）。
        style: 描画スタイル。

    Returns:
        X軸・Y軸のチェーン寸法をまとめた ``<g>`` 要素。
    """

    xs, ys = extract_chain_points(part, stock)
    group = g()
    group.children.append(_render_one_axis(xs, transform, axis="x", style=style))
    group.children.append(_render_one_axis(ys, transform, axis="y", style=style))
    return group


def _render_one_axis(
    points: list[float],
    transform: CoordTransform,
    *,
    axis: Literal["x", "y"],
    style: DimensionStyle,
) -> Element:
    """1軸分（内側チェーン + 全長）を組み立てる内部ヘルパ。"""

    sub = g()
    has_intermediate_points = len(points) > 2
    if has_intermediate_points:
        sub.children.append(
            render_axis_chain(points, transform, axis=axis, level_index=0, style=style)
        )
        total_level = 1
    else:
        total_level = 0

    total_points = [points[0], points[-1]]
    sub.children.append(
        render_axis_chain(total_points, transform, axis=axis, level_index=total_level, style=style)
    )
    return sub
