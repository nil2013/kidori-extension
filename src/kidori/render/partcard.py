"""加工指示図 SVG 生成（render/partcard.py）。

設計正本（.claude/logs/2026-07-22-design.md）§6 準拠。1つの部材定義（Part）を
1つの SVG 文書として描画する（qty 展開はしない。同一形状のため1ファイルで足りる）。

チェーン寸法線は render/dimension.py の :func:`render_part_dimensions` に委譲する
（本モジュールは寸法線の計算ロジックを持たない）。
"""

from __future__ import annotations

from kidori.model import Groove, Hole, Part, Stock, effective_width
from kidori.render.cutplan import circled_number
from kidori.render.dimension import (
    DimensionStyle,
    estimated_label_width,
    format_dimension_value as _fmt,
    render_part_dimensions,
)
from kidori.render.svgdoc import (
    CoordTransform,
    Element,
    SvgDocument,
    circle,
    g,
    line,
    rect,
    text,
)

# ---------------------------------------------------------------------------
# 定数
# ---------------------------------------------------------------------------

SCALE_BASE_PX = 900.0
SCALE_MIN = 0.2
SCALE_MAX = 4.0

FONT_SIZE_HEADER = 13.0
FONT_SIZE_ANNOTATION = 10.0
STROKE_WIDTH = 1.2

GROOVE_FRONT_FILL = "#f4c98a"
GROOVE_FRONT_OPACITY = 0.55
FEATURE_STROKE = "#333333"

HEADER_TOP_PAD = 8.0
HEADER_LINE_HEIGHT = 16.0
HEADER_BOTTOM_PAD = 16.0

#: 部材輪郭から寸法チェーン（最大2段: 中間＋全長）までの余白。
#: dimension.DimensionStyle の first_gap(10) + line_gap(14) を包含できる大きさにする。
BOTTOM_MARGIN = 60.0
LEFT_MARGIN = 70.0
#: 注記の右側退避リスト用の余白。
RIGHT_MARGIN = 240.0

ANNOTATION_LINE_HEIGHT = FONT_SIZE_ANNOTATION + 6.0


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _bbox_overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


# ---------------------------------------------------------------------------
# ヘッダ
# ---------------------------------------------------------------------------


def _build_header_lines(
    part: Part, stock: Stock, seq_labels: list[int] | None, plan_id: str | None
) -> list[str]:
    width = effective_width(part, stock)
    line1 = (
        f"{part.id}（{part.label}）｜qty {part.qty}｜"
        f"原材: {stock.id} (t{_fmt(stock.thickness)})｜{_fmt(part.length)} × {_fmt(width)}"
    )
    lines = [line1]
    if seq_labels:
        labels = "".join(circled_number(n) for n in seq_labels)
        lines.append(f"配置: 案{plan_id} {labels}")
    return lines


# ---------------------------------------------------------------------------
# 注記の配置（自然位置 or 右側リスト退避）
# ---------------------------------------------------------------------------


def _place_annotation(
    note: str,
    anchor_x: float,
    anchor_y: float,
    placed_boxes: list[tuple[float, float, float, float]],
    right_list_x: float,
    right_list_y: float,
) -> tuple[list[Element], float]:
    """注記1件を自然位置（引出点の右上）に置くか、被る場合は右側リストへ退避する。

    Returns:
        (描画要素一覧, 更新後の right_list_y)。``placed_boxes`` はこの関数内で
        追加分を破壊的に append する（呼び出し側は同じリストを使い回す）。
    """

    label_w = estimated_label_width(note, FONT_SIZE_ANNOTATION)
    label_h = FONT_SIZE_ANNOTATION + 4.0

    nat_x = anchor_x + 8.0
    nat_y = anchor_y - 8.0
    natural_bbox = (nat_x, nat_y - label_h, nat_x + label_w, nat_y + 2.0)

    if any(_bbox_overlap(natural_bbox, b) for b in placed_boxes):
        list_y = right_list_y + label_h
        elements = [
            line(
                anchor_x, anchor_y, right_list_x - 6.0, list_y - 4.0,
                stroke="#999999", stroke_width=0.5, data_role="leader-line",
            ),
            text(right_list_x, list_y, note, font_size=FONT_SIZE_ANNOTATION, data_role="annotation"),
        ]
        placed_boxes.append((right_list_x, list_y - label_h, right_list_x + label_w, list_y + 2.0))
        return elements, list_y

    elements = [
        line(
            anchor_x, anchor_y, nat_x - 2.0, nat_y + 2.0,
            stroke="#999999", stroke_width=0.5, data_role="leader-line",
        ),
        text(nat_x, nat_y, note, font_size=FONT_SIZE_ANNOTATION, data_role="annotation"),
    ]
    placed_boxes.append(natural_bbox)
    return elements, right_list_y


# ---------------------------------------------------------------------------
# フィーチャ描画
# ---------------------------------------------------------------------------


def _groove_local_rect(feature: Groove, part: Part, stock: Stock) -> tuple[float, float, float, float]:
    """溝を部材ローカル座標の矩形 (x, y, w, h) に変換する（設計正本 §6-2 段落）。"""

    half = feature.width / 2.0
    if feature.dir == "across":
        x0, x1 = feature.pos - half, feature.pos + half
        if feature.end == "through":
            y0, y1 = 0.0, effective_width(part, stock)
        else:
            y0, y1 = float(feature.from_), float(feature.to)
    else:  # "along"
        y0, y1 = feature.pos - half, feature.pos + half
        if feature.end == "through":
            x0, x1 = 0.0, float(part.length)
        else:
            x0, x1 = float(feature.from_), float(feature.to)
    return x0, y0, x1 - x0, y1 - y0


def _groove_note(feature: Groove) -> str:
    if feature.end == "through":
        return f"溝 幅{_fmt(feature.width)}×深{_fmt(feature.depth)} 通し（{feature.face}）"
    return (
        f"溝 幅{_fmt(feature.width)}×深{_fmt(feature.depth)} "
        f"止め {_fmt(feature.from_)}–{_fmt(feature.to)}（{feature.face}）"
    )


def _render_groove(
    feature: Groove,
    part: Part,
    stock: Stock,
    transform: CoordTransform,
    placed_boxes: list[tuple[float, float, float, float]],
    right_list_x: float,
    right_list_y: float,
) -> tuple[list[Element], float]:
    x0, y0, w0, h0 = _groove_local_rect(feature, part, stock)
    gx, gy, gw, gh = transform.rect(x0, y0, w0, h0)

    if feature.face == "front":
        shape = rect(
            gx, gy, gw, gh,
            fill=GROOVE_FRONT_FILL, fill_opacity=GROOVE_FRONT_OPACITY,
            stroke=FEATURE_STROKE, stroke_width=STROKE_WIDTH,
            data_role="groove", data_face="front",
        )
    else:
        shape = rect(
            gx, gy, gw, gh,
            fill="none", stroke=FEATURE_STROKE, stroke_width=STROKE_WIDTH,
            stroke_dasharray="5,3", data_role="groove", data_face="back",
        )

    anchor_x = gx + gw / 2.0
    anchor_y = gy
    ann_elements, right_list_y = _place_annotation(
        _groove_note(feature), anchor_x, anchor_y, placed_boxes, right_list_x, right_list_y
    )
    return [shape, *ann_elements], right_list_y


def _hole_note(feature: Hole) -> str:
    if feature.depth is None:
        return f"Φ{_fmt(feature.dia)} 貫通"
    return f"Φ{_fmt(feature.dia)} 深{_fmt(feature.depth)}"


def _render_hole(
    feature: Hole,
    transform: CoordTransform,
    placed_boxes: list[tuple[float, float, float, float]],
    right_list_x: float,
    right_list_y: float,
) -> tuple[list[Element], float]:
    cx, cy = transform.point(feature.x, feature.y)
    r = transform.length(feature.dia) / 2.0

    elements: list[Element] = [
        circle(cx, cy, r, fill="none", stroke=FEATURE_STROKE, stroke_width=STROKE_WIDTH, data_role="hole")
    ]
    if feature.depth is None:
        mark = max(r * 0.8, 3.0)
        elements.append(
            line(cx - mark, cy, cx + mark, cy, stroke=FEATURE_STROKE, stroke_width=0.8, data_role="hole-center-mark")
        )
        elements.append(
            line(cx, cy - mark, cx, cy + mark, stroke=FEATURE_STROKE, stroke_width=0.8, data_role="hole-center-mark")
        )

    anchor_x = cx + r
    anchor_y = cy - r
    ann_elements, right_list_y = _place_annotation(
        _hole_note(feature), anchor_x, anchor_y, placed_boxes, right_list_x, right_list_y
    )
    elements.extend(ann_elements)
    return elements, right_list_y


# ---------------------------------------------------------------------------
# 公開エントリ
# ---------------------------------------------------------------------------


def render_partcard(
    part: Part,
    stock: Stock,
    *,
    seq_labels: list[int] | None = None,
    plan_id: str | None = None,
) -> str:
    """1部材定義を1つの加工指示図 SVG 文書として描画する（設計正本 §6）。

    Args:
        part: 対象の部材定義。
        stock: part.stock が参照する原材。
        seq_labels: settings.selectedPlan が設定されている場合のみ渡す、
            この部材の全インスタンスの配置番号（Plan.seq 由来）リスト。
            None（未指定）の場合、ヘッダに配置番号行を出さない。
        plan_id: seq_labels 指定時に併記する採用案 ID（例: "A"）。

    Returns:
        SVG 文字列（``xml.etree.ElementTree.fromstring`` でパース可能）。
    """

    header_lines = _build_header_lines(part, stock, seq_labels, plan_id)
    top_margin = HEADER_TOP_PAD + len(header_lines) * HEADER_LINE_HEIGHT + HEADER_BOTTOM_PAD

    width_mm = float(part.length)
    height_mm = effective_width(part, stock)
    scale = _clamp(SCALE_BASE_PX / width_mm, SCALE_MIN, SCALE_MAX)
    length_px = scale * width_mm
    height_px = scale * height_mm

    doc_width = LEFT_MARGIN + length_px + RIGHT_MARGIN
    doc_height = top_margin + height_px + BOTTOM_MARGIN

    transform = CoordTransform(scale=scale, local_height=height_mm, offset_x=LEFT_MARGIN, offset_y=top_margin)

    elements: list[Element] = []
    ox, oy, ow, oh = transform.rect(0.0, 0.0, width_mm, height_mm)
    elements.append(rect(ox, oy, ow, oh, fill="none", stroke="black", stroke_width=STROKE_WIDTH, data_role="part-outline"))

    placed_boxes: list[tuple[float, float, float, float]] = []
    right_list_x = LEFT_MARGIN + length_px + 16.0
    right_list_y = top_margin + 4.0

    for feature in part.features:
        if isinstance(feature, Groove):
            feature_elements, right_list_y = _render_groove(
                feature, part, stock, transform, placed_boxes, right_list_x, right_list_y
            )
        elif isinstance(feature, Hole):
            feature_elements, right_list_y = _render_hole(
                feature, transform, placed_boxes, right_list_x, right_list_y
            )
        else:  # pragma: no cover - model.py の Feature は Groove|Hole に限定される
            continue
        elements.extend(feature_elements)

    elements.append(render_part_dimensions(part, stock, transform, DimensionStyle()))

    doc = SvgDocument(width=doc_width, height=doc_height)
    for i, line_text in enumerate(header_lines):
        doc.add(
            text(
                10.0,
                HEADER_TOP_PAD + (i + 1) * HEADER_LINE_HEIGHT,
                line_text,
                font_size=FONT_SIZE_HEADER,
                data_role="header",
            )
        )
    doc.add(g(elements))

    return doc.render()
