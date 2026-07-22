"""kidori の正本データモデル（内部表現）。

project.yaml / project.json を読み込み・検証した後の内部データモデルを定義する。
すべて frozen dataclass とし、読込後の不変性を保証する（build 処理中に変更されない）。

単位は mm 固定。部材ローカル座標系は左下原点・X 右・Y 上（SPECS.md §4a）。

YAML キーと Python 属性名の対応（キャメルケース → スネークケース）は
loader.py（Phase 1）が担う。本モジュールはデータ形のみを定義する。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Union


@dataclass(frozen=True)
class Meta:
    """project.yaml の meta 区画。

    Attributes:
        project: プロジェクト名（例: "書棚"）。
        units: 単位。v1 では "mm" 固定（他値は loader が意味検証で error にする）。
        schema_version: YAML キー schemaVersion に対応する。正本のスキーマバージョン表記。
    """

    project: str
    units: Literal["mm"]
    schema_version: str


@dataclass(frozen=True)
class Settings:
    """project.yaml の settings 区画。割付・出力の全体設定。

    Attributes:
        kerf: 鋸刃厚（mm）。割付時に切断ごとに消費される。デフォルト 3。
        edge_trim: YAML キー edgeTrim に対応する。原材の端の捨て代（mm）。デフォルト 5。
        candidates: 生成する割付候補数。1〜3 にクランプする
            （4 以上の指定は loader が warning を出す）。デフォルト 3。
        selected_plan: YAML キー selectedPlan に対応する。採用した案の ID
            （"A"/"B"/"C"）。null の間は全案を出力する。
    """

    kerf: float = 3.0
    edge_trim: float = 5.0
    candidates: int = 3
    selected_plan: str | None = None


@dataclass(frozen=True)
class Stock:
    """stocks[] の1要素。原材（規格材）マスタの定義。

    Attributes:
        id: 原材 ID。parts[].stock から参照される。
        label: 表示ラベル（例: "1×4材 6F"）。
        kind: "bar"（1D割付・長さのみ使用）または "sheet"（2D割付・長さ×幅を使用）。
        length: 原材の長さ（mm）。
        width: 原材の幅（mm）。bar の場合は部材の実効幅として使われる
            （effective_width 参照）。
        thickness: 原材の厚み（mm）。
        price: 単価（円）。省略時は None（費用計算では price 欠落として扱われる）。
    """

    id: str
    label: str
    kind: Literal["bar", "sheet"]
    length: float
    width: float
    thickness: float
    price: float | None = None


@dataclass(frozen=True)
class Groove:
    """部材の加工フィーチャ: 溝。

    Attributes:
        face: 加工面。"front" は実線＋薄塗り、"back" は破線（隠れ線規約）で描画される。
        dir: 溝の走行方向。"across"（幅方向）または "along"（長さ方向）。
        pos: 基準端から溝中心までの距離（mm）。寸法線抽出でも中心基準として扱われる
            （手描き図面の 248/486/724 のような表記と一致させるため）。
        width: 溝幅（mm）。
        depth: 溝深さ（mm）。stock.thickness 以下でなければならない（意味検証層）。
        end: "through"（通し）または "stopped"（止め）。
        from_: YAML キー "from" に対応する（Python 予約語のため末尾アンダースコアを付す）。
            end="stopped" の場合のみ使用する、走行方向の開始座標（mm）。
            end="through" では None でなければならない。
        to: end="stopped" の場合のみ使用する、走行方向の終了座標（mm）。
            end="through" では None でなければならない。
    """

    face: Literal["front", "back"]
    dir: Literal["across", "along"]
    pos: float
    width: float
    depth: float
    end: Literal["through", "stopped"]
    from_: float | None = None
    to: float | None = None


@dataclass(frozen=True)
class Hole:
    """部材の加工フィーチャ: 丸穴。

    Attributes:
        face: 加工面。"front" または "back"。
        x: 部材ローカル座標系での中心 X 座標（mm）。
        y: 部材ローカル座標系での中心 Y 座標（mm）。
        dia: 径（mm）。
        depth: 深さ（mm）。None の場合は貫通を表す。
    """

    face: Literal["front", "back"]
    x: float
    y: float
    dia: float
    depth: float | None = None


# 部材の加工フィーチャは Groove（溝）または Hole（丸穴）のいずれか。
Feature = Union[Groove, Hole]


@dataclass(frozen=True)
class Part:
    """parts[] の1要素。切り出す部材の定義。

    Attributes:
        id: 部材 ID。
        label: 表示ラベル。
        qty: 必要数量。
        stock: 使用する原材の id 参照。
        length: 部材の長さ（mm）。
        width: 部材の幅（mm）。bar 部材では省略可（省略時、または指定時も
            stock.width と同値のみ許容。異なる値＝挽き割り指定は v1 対象外で
            意味検証層が error にする）。sheet 部材では必須（意味検証層で担保）。
        rot: 2D割付時の90°回転可否。デフォルト True。bar 部材では意味を持たない
            （意味検証層で warning、無視される）。
        features: 加工フィーチャ（Groove/Hole）のタプル。
    """

    id: str
    label: str
    qty: int
    stock: str
    length: float
    width: float | None = None
    rot: bool = True
    features: tuple[Feature, ...] = ()


@dataclass(frozen=True)
class Project:
    """project.yaml / project.json 読込・検証後のトップレベルモデル。"""

    meta: Meta
    settings: Settings
    stocks: tuple[Stock, ...]
    parts: tuple[Part, ...]


def effective_width(part: Part, stock: Stock) -> float:
    """割付・描画で使う部材の実効幅を返す。

    - stock.kind == "sheet" の場合: part.width をそのまま返す
      （sheet 部材は width 必須。意味検証層で担保される）。
    - stock.kind == "bar" の場合: stock.width を返す（bar 部材の width 指定は
      「stock.width と同値」以外は意味検証層で error になるため、実効幅としては
      常に stock.width を採用する）。

    Args:
        part: 対象の部材。
        stock: part.stock が参照する原材。

    Returns:
        実効幅（mm）。

    Raises:
        ValueError: sheet 部材で part.width が None の場合
            （意味検証層を経ていない不整合な入力）。
    """

    if stock.kind == "bar":
        return stock.width
    if part.width is None:
        raise ValueError(
            f"sheet 部材 {part.id!r} には width が必須です"
            "（意味検証層を経ていない入力の可能性があります）"
        )
    return part.width
