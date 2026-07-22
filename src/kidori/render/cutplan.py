"""木取り図 SVG 生成（render/cutplan.py）。

設計正本（.claude/logs/2026-07-22-design.md）§5 準拠。1つの割付案（Plan）を
1つの SVG 文書として描画する。案内の全 StockUnit（bar/sheet 混在可）を縦積みし、
原材 1 本／1 枚ごとに 1 パネルを描く。

依存方針: metrics.py は Phase 2 で並行実装中のため import しない。ヘッダの
歩留まり・費用・必要本数・カット回数は、呼び出し側が渡す ``summary`` 引数
（設計正本 §8 の JSON 例における ``plans[]`` の1要素相当の dict）から
``dict`` として読むだけに留める。パネル単体の歩留まり・端材長・kerf 帯は
Plan/StockUnit の実配置（実座標）から本モジュールが直接計算する
（summary の集計粒度はスキーマ単位であり、パネル単位の値ではないため）。
"""

from __future__ import annotations

from typing import Sequence

from kidori.model import Part, Project, Stock, effective_width
from kidori.packing.common import Placement1D, Placement2D, Plan, StockUnit
from kidori.render.dimension import format_dimension_value as _fmt
from kidori.render.svgdoc import (
    CoordTransform,
    Element,
    SvgDocument,
    defs,
    g,
    line,
    pattern,
    rect,
    text,
)

# ---------------------------------------------------------------------------
# 定数（設計正本 §5）
# ---------------------------------------------------------------------------

#: スケール算出の基準 px（案内で統一。scale = SCALE_BASE_PX / 全StockUnit中の最大 length）。
SCALE_BASE_PX = 1200.0
SCALE_MIN = 0.2
SCALE_MAX = 4.0

FONT_SIZE_BODY = 12.0
FONT_SIZE_HEADER = 16.0
STROKE_WIDTH = 1.0

PART_FILL = "#e8d9b5"
KERF_FILL = "#d9534f"
KERF_OPACITY = 0.45
REMNANT_FILL = "#dcdcdc"
EDGE_TRIM_HATCH_ID = "kidori-edge-trim-hatch"

MARGIN = 20.0
HEADER_HEIGHT = 26.0
PANEL_TITLE_HEIGHT = 20.0
PANEL_GAP = 24.0

#: 部材矩形内に「①id（＋label）」＋寸法の2行を収められる最小 px（幅・高さ）。
LABEL_FULL_MIN_W = 60.0
LABEL_FULL_MIN_H = 28.0
#: 1行目ラベルの推定文字幅係数（ASCII。dimension.CHAR_WIDTH_RATIO と同じ 0.62）。
LABEL_CHAR_RATIO_ASCII = 0.62
#: 全角文字（CJK 等）の推定文字幅係数。全角はほぼ 1em とみなす。
LABEL_CHAR_RATIO_WIDE = 1.0
#: 番号のみなら収められる最小 px。これ未満は矩形外に引出線で退避する。
LABEL_NUMBER_MIN_W = 18.0
LABEL_NUMBER_MIN_H = 14.0

#: 端材（残長）ラベルの表示に必要な最小 px 幅。
REMNANT_LABEL_MIN_W = 24.0

#: 丸数字（①〜⑳ = U+2460〜U+2473）。21 以上は "(21)" 形式にフォールバック。
_CIRCLED_BASE = 0x2460
_CIRCLED_MAX = 20


def circled_number(n: int) -> str:
    """1始まりの整数を丸数字1文字（①〜⑳）に変換する。21以上は "(21)" 形式。"""

    if 1 <= n <= _CIRCLED_MAX:
        return chr(_CIRCLED_BASE + n - 1)
    return f"({n})"


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


# ---------------------------------------------------------------------------
# ヘッダ
# ---------------------------------------------------------------------------


def _method_display(method_1d: str, method_2d: str) -> str:
    """Plan.method_1d / method_2d を設計正本 §5 のヘッダ表記に変換する。"""

    disp_1d = {"ffd": "FFD", "bfd": "BFD", "grouped": "同種グループ化"}.get(
        method_1d, method_1d.upper()
    )
    disp_2d = {"bssf": "MaxRects-BSSF", "baf": "MaxRects-BAF", "bl": "MaxRects-BL"}.get(
        method_2d, method_2d.upper()
    )
    return f"{disp_1d} / {disp_2d}"


def _cost_display(totals: dict) -> str:
    cost = totals.get("cost")
    if cost is None:
        return "概算費用 算出不可"
    return f"概算費用 ¥{round(cost):,}"


def _counts_display(totals: dict) -> str:
    counts: dict = totals.get("stockCounts", {}) or {}
    if not counts:
        return "必要本数: -"
    parts = ", ".join(f"{stock_id}×{count}" for stock_id, count in counts.items())
    return f"必要本数: {parts}"


def _build_header_text(plan: Plan, project: Project, summary: dict) -> str:
    totals: dict = summary.get("totals", {}) or {}
    yield_value = totals.get("yield")
    yield_str = f"{yield_value * 100:.1f}%" if yield_value is not None else "算出不可"
    cut_count = totals.get("cutCount", 0)

    segments = [
        f"案{plan.id}",
        f"方式: {_method_display(plan.method_1d, plan.method_2d)}",
        f"歩留まり(全体) {yield_str}",
        _cost_display(totals),
        _counts_display(totals),
        f"カット回数 {cut_count}",
    ]
    header = " ｜ ".join(segments)
    if project.settings.selected_plan == plan.id:
        header += " 【採用】"
    return header


# ---------------------------------------------------------------------------
# defs（edgeTrim ハッチパターン）
# ---------------------------------------------------------------------------


def _edge_trim_defs() -> Element:
    hatch = pattern(
        EDGE_TRIM_HATCH_ID,
        6,
        6,
        patternUnits="userSpaceOnUse",
        patternTransform="rotate(45)",
        children=[
            rect(0, 0, 6, 6, fill="#f2f2f2"),
            line(0, 0, 0, 6, stroke="#999999", stroke_width=2),
        ],
    )
    return defs([hatch])


# ---------------------------------------------------------------------------
# ラベル配置（部材矩形内 or 引出線退避）
# ---------------------------------------------------------------------------


def _estimated_text_width(content: str, font_size: float) -> float:
    """ラベル文字列の推定描画幅（px）を返す（ASCII は 0.62em、全角は 1em とみなす）。"""

    width = 0.0
    for ch in content:
        ratio = LABEL_CHAR_RATIO_ASCII if ord(ch) < 0x0100 else LABEL_CHAR_RATIO_WIDE
        width += ratio * font_size
    return width


def _part_label_elements(
    *,
    seq_num: int,
    part_id: str,
    part_label: str,
    dims_text: str,
    rect_x: float,
    rect_y: float,
    rect_w: float,
    rect_h: float,
) -> list[Element]:
    """部材矩形の中央（または矩形外・引出線付き）にラベルを配置する。

    縮退規則（SPECS §6「部材 ID・ラベル・寸法を記入」＋設計正本 §5 の実装者判断）:
        1. 矩形が十分大きい: 1行目「① id label」＋2行目に寸法。
           1行目の推定幅が矩形幅を超える場合は label を落とし「① id」に縮退。
        2. 番号のみ収まる大きさ: 「①」のみ。
        3. それ未満: 矩形外へ番号を引出線付きで退避。
    """

    cx = rect_x + rect_w / 2
    cy = rect_y + rect_h / 2
    seq_label = circled_number(seq_num)
    elements: list[Element] = []

    if rect_w >= LABEL_FULL_MIN_W and rect_h >= LABEL_FULL_MIN_H:
        full_line = f"{seq_label} {part_id} {part_label}" if part_label else f"{seq_label} {part_id}"
        if _estimated_text_width(full_line, FONT_SIZE_BODY) > rect_w:
            full_line = f"{seq_label} {part_id}"
        elements.append(
            text(
                cx,
                cy - 2,
                full_line,
                font_size=FONT_SIZE_BODY,
                text_anchor="middle",
                data_role="seq-label",
            )
        )
        elements.append(
            text(
                cx,
                cy + FONT_SIZE_BODY + 1,
                dims_text,
                font_size=FONT_SIZE_BODY,
                text_anchor="middle",
                data_role="part-dims",
            )
        )
        return elements

    if rect_w >= LABEL_NUMBER_MIN_W and rect_h >= LABEL_NUMBER_MIN_H:
        elements.append(
            text(
                cx,
                cy + FONT_SIZE_BODY / 3,
                seq_label,
                font_size=FONT_SIZE_BODY,
                text_anchor="middle",
                data_role="seq-label",
            )
        )
        return elements

    # 矩形が小さすぎる: 矩形外（右上）へ引出線付きで退避する。
    label_x = rect_x + rect_w + 14
    label_y = rect_y - 4
    elements.append(
        line(
            cx,
            cy,
            label_x - 2,
            label_y + 2,
            stroke="#666666",
            stroke_width=0.5,
            data_role="leader-line",
        )
    )
    elements.append(
        text(
            label_x,
            label_y,
            seq_label,
            font_size=FONT_SIZE_BODY,
            text_anchor="start",
            data_role="seq-label",
        )
    )
    return elements


# ---------------------------------------------------------------------------
# パネル本体（1D / 2D）
# ---------------------------------------------------------------------------


def _render_bar_unit(
    unit: StockUnit,
    plan: Plan,
    project: Project,
    transform: CoordTransform,
) -> tuple[list[Element], float]:
    stock = unit.stock
    placements: list[Placement1D] = sorted(unit.placements, key=lambda p: p.start)  # type: ignore[arg-type]
    elements: list[Element] = []
    total_len = 0.0

    for i, placement in enumerate(placements):
        part: Part = placement.instance.part
        length = part.length
        width = effective_width(part, stock)
        total_len += length

        sx, sy, sw, sh = transform.rect(placement.start, 0.0, length, width)
        elements.append(
            rect(sx, sy, sw, sh, fill=PART_FILL, stroke="black", stroke_width=STROKE_WIDTH, data_role="part-rect")
        )
        seq_num = plan.seq.get(placement.instance.instance_id, 0)
        elements.extend(
            _part_label_elements(
                seq_num=seq_num,
                part_id=part.id,
                part_label=part.label,
                dims_text=_fmt(length),
                rect_x=sx,
                rect_y=sy,
                rect_w=sw,
                rect_h=sh,
            )
        )

        if i + 1 < len(placements):
            nxt = placements[i + 1]
            gap_start = placement.start + length
            gap_end = nxt.start
            if gap_end - gap_start > 1e-6:
                kx, ky, kw, kh = transform.rect(gap_start, 0.0, gap_end - gap_start, width)
                elements.append(
                    rect(
                        kx,
                        ky,
                        kw,
                        kh,
                        fill=KERF_FILL,
                        fill_opacity=KERF_OPACITY,
                        stroke="none",
                        data_role="kerf-band",
                    )
                )

    if placements:
        last = placements[-1]
        end_edge = last.start + last.instance.part.length
        remnant_end = stock.length - project.settings.edge_trim
        remnant_len = remnant_end - end_edge
        if remnant_len > 1e-6:
            rx, ry, rw, rh = transform.rect(end_edge, 0.0, remnant_len, stock.width)
            elements.append(
                rect(rx, ry, rw, rh, fill=REMNANT_FILL, stroke="none", data_role="remnant")
            )
            if rw >= REMNANT_LABEL_MIN_W:
                elements.append(
                    text(
                        rx + rw / 2,
                        ry + rh / 2,
                        _fmt(remnant_len),
                        font_size=FONT_SIZE_BODY,
                        text_anchor="middle",
                        dominant_baseline="middle",
                        fill="#666666",
                        data_role="remnant-label",
                    )
                )

    yield_frac = total_len / stock.length if stock.length > 0 else 0.0
    return elements, yield_frac


def _render_sheet_unit(
    unit: StockUnit,
    plan: Plan,
    project: Project,
    transform: CoordTransform,
) -> tuple[list[Element], float]:
    stock = unit.stock
    kerf = project.settings.kerf
    placements: list[Placement2D] = list(unit.placements)  # type: ignore[assignment]
    elements: list[Element] = []
    total_area = 0.0

    for placement in placements:
        part: Part = placement.instance.part
        plen = part.length
        pwid = effective_width(part, stock)
        total_area += plen * pwid

        if placement.rotated:
            extent_x, extent_y = pwid, plen
        else:
            extent_x, extent_y = plen, pwid

        sx, sy, sw, sh = transform.rect(placement.x, placement.y, extent_x, extent_y)
        elements.append(
            rect(sx, sy, sw, sh, fill=PART_FILL, stroke="black", stroke_width=STROKE_WIDTH, data_role="part-rect")
        )
        seq_num = plan.seq.get(placement.instance.instance_id, 0)
        elements.extend(
            _part_label_elements(
                seq_num=seq_num,
                part_id=part.id,
                part_label=part.label,
                dims_text=f"{_fmt(plen)}×{_fmt(pwid)}",
                rect_x=sx,
                rect_y=sy,
                rect_w=sw,
                rect_h=sh,
            )
        )

        if kerf > 1e-9:
            # 右帯
            rkx, rky, rkw, rkh = transform.rect(placement.x + extent_x, placement.y, kerf, extent_y)
            elements.append(
                rect(rkx, rky, rkw, rkh, fill=KERF_FILL, fill_opacity=KERF_OPACITY, stroke="none", data_role="kerf-band")
            )
            # 上帯（角を含めるため幅を kerf 分広げる）
            tkx, tky, tkw, tkh = transform.rect(
                placement.x, placement.y + extent_y, extent_x + kerf, kerf
            )
            elements.append(
                rect(tkx, tky, tkw, tkh, fill=KERF_FILL, fill_opacity=KERF_OPACITY, stroke="none", data_role="kerf-band")
            )

    area_total = stock.length * stock.width
    yield_frac = total_area / area_total if area_total > 0 else 0.0
    return elements, yield_frac


# ---------------------------------------------------------------------------
# パネル（原材1本/1枚）
# ---------------------------------------------------------------------------


def _render_panel(
    unit: StockUnit,
    plan: Plan,
    project: Project,
    scale: float,
    offset_x: float,
    offset_y: float,
) -> tuple[Element, float, float]:
    """1パネル（タイトル込み）を描画する。戻り値: (要素, パネル幅px, パネル高さpx)。"""

    stock = unit.stock
    transform = CoordTransform(scale=scale, local_height=stock.width, offset_x=offset_x, offset_y=offset_y)
    length_px = transform.length(stock.length)
    width_px = transform.length(stock.width)

    elements: list[Element] = []

    # 原材外形
    ox, oy, ow, oh = transform.rect(0.0, 0.0, stock.length, stock.width)
    elements.append(rect(ox, oy, ow, oh, fill="none", stroke="black", stroke_width=STROKE_WIDTH, data_role="stock-outline"))

    # edgeTrim 域（1D は長さ方向の先端・末尾のみ。2D は §4 の Lu/Wu モデルに
    # 合わせ、長さ・幅の両軸の縁を対象とする）。
    edge_trim = project.settings.edge_trim
    if edge_trim > 1e-9:
        for x0 in (0.0, stock.length - edge_trim):
            ex, ey, ew, eh = transform.rect(x0, 0.0, edge_trim, stock.width)
            elements.append(
                rect(
                    ex, ey, ew, eh,
                    fill=f"url(#{EDGE_TRIM_HATCH_ID})",
                    stroke="none",
                    data_role="edge-trim",
                )
            )
        if stock.kind == "sheet":
            for y0 in (0.0, stock.width - edge_trim):
                ex, ey, ew, eh = transform.rect(0.0, y0, stock.length, edge_trim)
                elements.append(
                    rect(
                        ex, ey, ew, eh,
                        fill=f"url(#{EDGE_TRIM_HATCH_ID})",
                        stroke="none",
                        data_role="edge-trim",
                    )
                )

    if stock.kind == "bar":
        unit_elements, unit_yield = _render_bar_unit(unit, plan, project, transform)
    else:
        unit_elements, unit_yield = _render_sheet_unit(unit, plan, project, transform)
    elements.extend(unit_elements)

    title = f"{stock.id} #{unit.index}／{_fmt(stock.length)}×{_fmt(stock.width)}×{_fmt(stock.thickness)}｜歩留まり {unit_yield * 100:.1f}%"
    title_elem = text(
        offset_x,
        offset_y - 6,
        title,
        font_size=FONT_SIZE_BODY,
        data_role="panel-title",
    )

    return g([title_elem, *elements]), length_px, width_px


# ---------------------------------------------------------------------------
# 公開エントリ
# ---------------------------------------------------------------------------


def render_cutplan(plan: Plan, project: Project, summary: dict) -> str:
    """1つの割付案を1つの木取り図 SVG 文書として描画する（設計正本 §5）。

    Args:
        plan: 描画対象の割付案（packing.generate_plans の戻り値の1要素）。
        project: 正本データ（settings.kerf/edge_trim/selected_plan の参照に使う）。
        summary: metrics の plans[] 相当の1要素 dict（設計正本 §8 の形。ヘッダの
            歩留まり(全体)・概算費用・必要本数・カット回数の表示にのみ使う）。

    Returns:
        SVG 文字列（``xml.etree.ElementTree.fromstring`` でパース可能）。
    """

    units = plan.units
    max_length = max((u.stock.length for u in units), default=1.0)
    scale = _clamp(SCALE_BASE_PX / max_length, SCALE_MIN, SCALE_MAX)

    panels: list[Element] = []
    doc_width = 0.0
    y_cursor = MARGIN + HEADER_HEIGHT

    for unit in units:
        panel_offset_y = y_cursor + PANEL_TITLE_HEIGHT
        panel_elem, panel_w, panel_h = _render_panel(
            unit, plan, project, scale, MARGIN, panel_offset_y
        )
        panels.append(panel_elem)
        doc_width = max(doc_width, MARGIN + panel_w + MARGIN)
        y_cursor = panel_offset_y + panel_h + PANEL_GAP

    doc_height = y_cursor + MARGIN
    if doc_width <= 0:
        doc_width = MARGIN * 2 + SCALE_BASE_PX

    doc = SvgDocument(width=doc_width, height=doc_height)
    doc.add(_edge_trim_defs())
    doc.add(
        text(
            MARGIN,
            MARGIN + FONT_SIZE_HEADER,
            _build_header_text(plan, project, summary),
            font_size=FONT_SIZE_HEADER,
            data_role="header",
        )
    )
    for panel in panels:
        doc.add(panel)

    return doc.render()
