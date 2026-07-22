"""割付結果の共通データ型と、kerf/edgeTrim 消費モデルのヘルパ関数。

本モジュールは全割付トラック（pack1d.py / pack2d.py）・metrics.py・render 系が
共有する契約であり、設計正本（.claude/logs/2026-07-22-design.md）§1・§3 の定義を
単一の実装として集約する。以後、kerf/edgeTrim に関する計算はすべてここを経由する。

## kerf・edgeTrim 消費モデル（§3 の要約。厳密定義は設計正本を参照）

- edgeTrim = 「生端から edgeTrim mm 以内の材は不健全（荒れ・割れ）」の深さ。
  部材の実体はこの不健全域に一切かかってはならない。
- 使用可能窓: [edgeTrim, L − edgeTrim]、有効長 U = L − 2・edgeTrim（usable_length）。
- 配置: o_1 = edgeTrim、o_{i+1} = o_i + len_i + kerf。
- 充填可否: Σlen_i + (n−1)・kerf ≤ U（等号成立を許容。fits_1d）。
- カット回数（1本あたり）:
  (1 if edgeTrim>0 else 0) + (n−1) + (1 if not (edgeTrim==0 かつ E==L) else 0)
  （cut_count_1d）。E は最後の部材の右端座標。

浮動小数の等号成立判定は EPS = 1e-9 で許容する。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Union

from kidori.model import Part, Settings, Stock

#: 浮動小数比較の許容誤差。境界値（等号成立）判定に用いる。
#: 全モジュールはこの定数を import して使用し、独自の epsilon を定義しない。
EPS = 1e-9


@dataclass(frozen=True)
class PartInstance:
    """qty 展開後の部材1個。

    parts[].qty > 1 の場合、同一 Part から qty 個の PartInstance が
    index=1..qty で生成される。

    Attributes:
        part: 元となる Part 定義。
        index: 同一 Part 内の通し番号（1始まり）。
    """

    part: Part
    index: int

    @property
    def instance_id(self) -> str:
        """`{part.id}#{index}` 形式の一意な識別子を返す。"""
        return f"{self.part.id}#{self.index}"


@dataclass(frozen=True)
class Placement1D:
    """1D割付における1個の部材の配置。

    Attributes:
        instance: 配置される部材インスタンス。
        start: 原材の生端（stock の物理的な端、x=0）から部材の左端までの距離（mm）。
    """

    instance: PartInstance
    start: float


@dataclass(frozen=True)
class Placement2D:
    """2D割付における1個の部材の配置。

    Attributes:
        instance: 配置される部材インスタンス。
        x: 原材の生端左下を原点とした、部材左下角の X 座標（mm、実座標）。
        y: 原材の生端左下を原点とした、部材左下角の Y 座標（mm、実座標）。
        rotated: 90°回転して配置されたか（True の場合、実寸は width×length になる）。
    """

    instance: PartInstance
    x: float
    y: float
    rotated: bool


@dataclass
class StockUnit:
    """割付に使われた原材1本（1D）または1枚（2D）。

    Attributes:
        stock: 使用する原材の定義。
        index: 同一原材 id 内での通し番号（1始まり）。
        placements: この原材上の配置一覧。stock.kind=="bar" なら
            list[Placement1D]、"sheet" なら list[Placement2D]。
    """

    stock: Stock
    index: int
    placements: list[Union[Placement1D, Placement2D]] = field(default_factory=list)


@dataclass
class Plan:
    """1つの割付案（A/B/C のいずれか）。

    Attributes:
        id: 案 ID（"A"/"B"/"C"）。
        method_1d: 適用した1D割付方式（"ffd"/"bfd"/"grouped"）。
        method_2d: 適用した2D割付方式（"bssf"/"baf"/"bl"）。
        units: この案で使用する StockUnit の一覧（bar/sheet 混在可）。
        seq: instance_id → 配置番号（①②③…に対応する 1始まりの整数）の対応表。
            units→placements の順（1D は start 昇順、2D は (y, x) 昇順）で
            通し採番される。木取り図・加工指示図の連動に使う。
    """

    id: str
    method_1d: str
    method_2d: str
    units: list[StockUnit] = field(default_factory=list)
    seq: dict[str, int] = field(default_factory=dict)


def usable_length(stock_length: float, edge_trim: float) -> float:
    """1D割付の有効長 U = L − 2・edgeTrim を返す。

    Args:
        stock_length: 原材の長さ L（mm）。
        edge_trim: 端の捨て代 edgeTrim（mm）。

    Returns:
        有効長 U（mm）。
    """
    return stock_length - 2.0 * edge_trim


def fits_1d(
    used_len: float,
    count: int,
    part_len: float,
    kerf: float,
    usable: float,
) -> bool:
    """指定の部材が原材内の残り容量に収まるかを判定する。

    充填可否条件: `used_len + (kerf if count > 0 else 0) + part_len <= usable`。
    浮動小数の等号成立は EPS で許容する（境界値は「収まる」側に倒す）。

    Args:
        used_len: これまでにこの原材へ配置した部材長の合計（kerf を含む）。
        count: これまでにこの原材へ配置した部材の個数（0始まり）。
            0 の場合は先頭配置のため kerf を消費しない。
        part_len: 新たに配置しようとする部材の長さ（mm）。
        kerf: 鋸刃厚（mm）。
        usable: 有効長 U（mm、usable_length の戻り値）。

    Returns:
        収まるなら True。
    """
    needed = used_len + (kerf if count > 0 else 0.0) + part_len
    return needed <= usable + EPS


def cut_count_1d(
    placements: list[Placement1D],
    stock: Stock,
    settings: Settings,
) -> int:
    """1本の原材に対する1D割付のカット回数を返す。

    設計正本 §3 の式:
        (1 if edgeTrim>0 else 0) + (n−1) + (1 if not (edgeTrim==0 かつ E==L) else 0)

    E は最後（start が最大）の部材の右端座標 `start + part.length`、
    L は stock.length。edgeTrim==0 の判定・E==L の判定はいずれも EPS で許容する。

    Args:
        placements: この原材上の1D配置一覧（順不同で渡してよい。内部で start 順に並べる）。
        stock: 対象の原材。
        settings: kerf・edgeTrim を含む設定。

    Returns:
        カット回数。placements が空の場合は 0。
    """
    n = len(placements)
    if n == 0:
        return 0

    edge_trim = settings.edge_trim
    last = max(placements, key=lambda p: p.start)
    end_edge = last.start + last.instance.part.length

    leading = 0 if edge_trim <= EPS else 1
    interior = n - 1
    trailing_omit = (edge_trim <= EPS) and (abs(end_edge - stock.length) <= EPS)
    trailing = 0 if trailing_omit else 1

    return leading + interior + trailing
