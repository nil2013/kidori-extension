"""依存ゼロの SVG 文字列ビルダ。

SPECS.md §6・設計正本（.claude/logs/2026-07-22-design.md）§5・§6 の
木取り図（plan-X.svg）・加工指示図（parts/<id>.svg）が共通で使う下地を提供する。
外部ライブラリには依存しない（文字列組み立てのみ）。

このモジュールが提供するもの:
    - 要素ツリー（:class:`Element`）と要素生成関数（:func:`rect`/:func:`line`/
      :func:`circle`/:func:`text`/:func:`path`/:func:`pattern`/:func:`g`/:func:`defs`）
    - 属性値・テキストのエスケープ（:func:`escape_attr`/:func:`escape_text`）
    - 部材ローカル座標系（左下原点・Y上向き）→ SVG 座標系（左上原点・Y下向き）の
      変換ヘルパ（:class:`CoordTransform`）
    - viewBox/width/height を備えた文書の組み立て（:class:`SvgDocument`）

Phase 2（render/cutplan.py・render/partcard.py）からの利用イメージ:

    >>> from kidori.render.svgdoc import SvgDocument, CoordTransform, rect, text, g
    >>> # 1820mm 長の原材を scale=0.5 (px/mm) でパネル (offset_x=10, offset_y=10) に描く
    >>> tr = CoordTransform(scale=0.5, local_height=89, offset_x=10, offset_y=10)
    >>> sx, sy, sw, sh = tr.rect(0, 0, 600, 89)  # 部材ローカル矩形 → SVG rect 引数
    >>> panel = g(children=[
    ...     rect(sx, sy, sw, sh, fill="#e8d9b5", stroke="black"),
    ...     text(sx + sw / 2, sy + sh / 2, "side-0", text_anchor="middle"),
    ... ])
    >>> doc = SvgDocument(width=920, height=200)
    >>> doc.add(panel)
    >>> svg_text = doc.render()  # xml.etree.ElementTree.fromstring(svg_text) でパース可能

各出力ファイル（plan-X.svg・parts/<id>.svg）は、1つの :class:`SvgDocument` に
複数パネル（原材1本ごと・部材1点ごと）を :class:`CoordTransform` のオフセットを
ずらしながら :func:`g` でまとめて追加していく想定である。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Union

Number = Union[int, float]

#: 文書ルートに付与するデフォルトの font-family。
#: 日本語（ヘッダ・注記・ラベル）を含む出力のため、CJK グリフを持つフォントへの
#: フォールバック連鎖を macOS（Hiragino Sans）・Linux（Noto Sans CJK JP）の
#: 両対応で指定する。これが無いと cairosvg での PNG 変換時に日本語が
#: 豆腐（□）化する（SPECS §6: PNG は印刷・スマホでの現場参照用のため判読必須）。
DEFAULT_FONT_FAMILY = "Hiragino Sans, Noto Sans CJK JP, sans-serif"


# ---------------------------------------------------------------------------
# エスケープ・数値整形
# ---------------------------------------------------------------------------


def escape_attr(value: str) -> str:
    """属性値（ダブルクォートで囲む前提）のエスケープを行う。"""

    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def escape_text(value: str) -> str:
    """テキストノードのエスケープを行う（属性値と異なり引用符は不要）。"""

    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _format_number(value: Number) -> str:
    """数値を SVG 属性向けの文字列に整形する。

    整数値（またはそれと等価な float）は整数表記、それ以外は小数第3位までに丸めて
    末尾の 0 を削る（浮動小数演算の丸め誤差で ``1.2000000000000002`` のような
    冗長な表記になることを防ぐ）。
    """

    if isinstance(value, bool):  # bool は int のサブクラスなので先に弾く
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value == int(value):
            return str(int(value))
        text = f"{value:.3f}".rstrip("0").rstrip(".")
        return text if text else "0"
    return str(value)


def _format_attr_value(value: object) -> str:
    if isinstance(value, str):
        return escape_attr(value)
    if isinstance(value, (int, float)):
        return escape_attr(_format_number(value))
    return escape_attr(str(value))


def _attr_name(key: str) -> str:
    """kwargs のキー名（アンダースコア区切り）を SVG 属性名（ハイフン区切り）に変換する。

    既にハイフンを含むキー（``**{"stroke-width": 1}`` のように dict 展開で渡した場合）は
    そのまま使う。末尾アンダースコア（``class_`` のような Python 予約語回避）は除去する。
    """

    if "-" in key:
        return key
    if key.endswith("_"):
        key = key[:-1]
    return key.replace("_", "-")


# ---------------------------------------------------------------------------
# 要素ツリー
# ---------------------------------------------------------------------------


@dataclass
class Element:
    """SVG 要素1個を表す木構造ノード。

    ``children`` が非空ならコンテナ要素として、空で ``text`` が指定されていれば
    テキストノードを持つ要素として、どちらでもなければ自己終端タグとして描画する。
    """

    tag: str
    attrs: dict[str, object] = field(default_factory=dict)
    children: list["Element"] = field(default_factory=list)
    text: str | None = None

    def render(self, indent: int = 0, indent_size: int = 2) -> str:
        """インデント整形した SVG 文字列を返す。"""

        pad = " " * (indent * indent_size)
        attrs_str = "".join(
            f' {_attr_name(k)}="{_format_attr_value(v)}"'
            for k, v in self.attrs.items()
            if v is not None
        )
        if self.children:
            inner = "\n".join(
                child.render(indent + 1, indent_size) for child in self.children
            )
            return f"{pad}<{self.tag}{attrs_str}>\n{inner}\n{pad}</{self.tag}>"
        if self.text is not None:
            return f"{pad}<{self.tag}{attrs_str}>{escape_text(self.text)}</{self.tag}>"
        return f"{pad}<{self.tag}{attrs_str}/>"


def element(
    tag: str,
    *,
    children: Iterable[Element] | None = None,
    text: str | None = None,
    **attrs: object,
) -> Element:
    """任意タグの要素を生成する汎用ビルダ。個別ヘルパで表現できない要素に使う。"""

    return Element(tag=tag, attrs=dict(attrs), children=list(children or []), text=text)


def rect(x: Number, y: Number, width: Number, height: Number, **attrs: object) -> Element:
    """``<rect>`` 要素を生成する（SVG 座標系・左上原点）。"""

    return element("rect", x=x, y=y, width=width, height=height, **attrs)


def line(x1: Number, y1: Number, x2: Number, y2: Number, **attrs: object) -> Element:
    """``<line>`` 要素を生成する。"""

    return element("line", x1=x1, y1=y1, x2=x2, y2=y2, **attrs)


def circle(cx: Number, cy: Number, r: Number, **attrs: object) -> Element:
    """``<circle>`` 要素を生成する。"""

    return element("circle", cx=cx, cy=cy, r=r, **attrs)


def text(x: Number, y: Number, content: str, **attrs: object) -> Element:
    """``<text>`` 要素を生成する。``content`` はテキストノードとしてエスケープされる。"""

    return element("text", x=x, y=y, text=content, **attrs)


def path(d: str, **attrs: object) -> Element:
    """``<path>`` 要素を生成する。``d`` はパスデータ文字列。"""

    return element("path", d=d, **attrs)


def pattern(
    id: str,  # noqa: A002 - SVG 属性名 id にそのまま合わせる
    width: Number,
    height: Number,
    children: Iterable[Element] | None = None,
    **attrs: object,
) -> Element:
    """``<pattern>`` 要素を生成する（edgeTrim のハッチング等、defs 内で再利用する定義用）。"""

    return element("pattern", id=id, width=width, height=height, children=children, **attrs)


def g(children: Iterable[Element] | None = None, **attrs: object) -> Element:
    """``<g>`` 要素（グループ）を生成する。"""

    return element("g", children=children, **attrs)


def defs(children: Iterable[Element] | None = None) -> Element:
    """``<defs>`` 要素を生成する（pattern 等の再利用定義をまとめる）。"""

    return element("defs", children=children)


# ---------------------------------------------------------------------------
# 座標変換
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CoordTransform:
    """部材ローカル座標系（左下原点・Y 上向き、mm）を SVG 座標系（左上原点・Y 下向き、px）へ変換する。

    SPECS.md §4a: 部材ローカル座標系は左下原点・X 右・Y 上。
    SVG は左上原点・Y 下向きのため、変換にはローカル座標系の高さ（``local_height``）を
    基準にした Y 反転が必要になる（例: bar 部材／sheet 部材なら stock.width、
    加工指示図の部材単体なら ``effective_width(part, stock)``）。

    Attributes:
        scale: mm から px への倍率。
        local_height: Y 反転の基準となるローカル座標系の高さ（mm）。
        offset_x: SVG 文書内でのパネル配置オフセット（px）。複数パネルを
            1つの SvgDocument にまとめる際、パネルごとにずらして使う。
        offset_y: 同上（Y 方向）。
    """

    scale: float
    local_height: float
    offset_x: float = 0.0
    offset_y: float = 0.0

    def point(self, x: float, y: float) -> tuple[float, float]:
        """ローカル座標 (x, y)（mm）を SVG 座標 (px) に変換する。"""

        sx = self.offset_x + x * self.scale
        sy = self.offset_y + (self.local_height - y) * self.scale
        return sx, sy

    def length(self, value: float) -> float:
        """長さ（スカラー、mm）を px に変換する（オフセット・反転は適用しない）。"""

        return value * self.scale

    def rect(
        self, x: float, y: float, width: float, height: float
    ) -> tuple[float, float, float, float]:
        """ローカル矩形（左下原点 (x, y)、幅 width・高さ height、mm）を
        SVG の ``<rect>`` 用引数 (x, y, width, height)（px、左上原点）に変換する。

        SVG の rect は左上原点で幅・高さを右下方向に取るため、ローカル矩形の
        左上角 ``(x, y + height)`` を基準点として変換する。
        """

        sx, sy = self.point(x, y + height)
        return sx, sy, self.length(width), self.length(height)


# ---------------------------------------------------------------------------
# 文書組み立て
# ---------------------------------------------------------------------------


@dataclass
class SvgDocument:
    """viewBox・width・height を備えた SVG 文書を組み立てる。

    Attributes:
        width: 文書の width 属性値（px）。
        height: 文書の height 属性値（px）。
        view_box: ``(min_x, min_y, width, height)``。省略時は ``(0, 0, width, height)``。
        font_family: ルート ``<svg>`` に付与する font-family（子要素へ継承される）。
            デフォルトは :data:`DEFAULT_FONT_FAMILY`（CJK 対応フォールバック連鎖）。
            None を指定すると属性を付与しない。
    """

    width: Number
    height: Number
    view_box: tuple[Number, Number, Number, Number] | None = None
    children: list[Element] = field(default_factory=list)
    font_family: str | None = DEFAULT_FONT_FAMILY

    def add(self, *elements: Element) -> "SvgDocument":
        """子要素を末尾に追加する（メソッドチェーン用に self を返す）。"""

        self.children.extend(elements)
        return self

    def to_element(self) -> Element:
        """ルートの ``<svg>`` 要素を組み立てて返す。"""

        vb = self.view_box or (0, 0, self.width, self.height)
        view_box_str = " ".join(_format_number(v) for v in vb)
        attrs: dict[str, object] = {
            "xmlns": "http://www.w3.org/2000/svg",
            "viewBox": view_box_str,
            "width": self.width,
            "height": self.height,
        }
        if self.font_family is not None:
            attrs["font-family"] = self.font_family
        return Element(
            tag="svg",
            attrs=attrs,
            children=list(self.children),
        )

    def render(self) -> str:
        """XML 宣言付きの SVG 文字列を返す（ファイルにそのまま書き出せる）。"""

        return '<?xml version="1.0" encoding="UTF-8"?>\n' + self.to_element().render()
