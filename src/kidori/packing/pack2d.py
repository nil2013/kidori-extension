"""2D 割付（板材の自由配置）— MaxRects ヒューリスティクス（Jylänki 準拠）。

設計正本（.claude/logs/2026-07-22-design.md）§4 の実装。sheet 原材に対し、
複数の部材を自由配置で割り付ける。案 A/B/C は「スコア関数 × 部材ソート順」を
変えることで生成する（bssf / baf / bl）。

## 膨張座標系（kerf / edgeTrim のモデル化）

古典的な「アイテム膨張」方式を用いる。

- ビン（配置空間）= (Lu + kerf) × (Wu + kerf)。Lu = L − 2e, Wu = W − 2e。
- 各部材は (l + kerf) × (w + kerf) に膨張して配置する。
- これにより「部材間の隙間 ≥ kerf」と「使用可能窓の縁には kerf 不要（縁の切り出し
  カットの刃は不健全域＝edgeTrim 域へ逃げる）」が同時に成立する（§3 の原理と整合）。
- 実座標復元: 膨張座標 (x, y) → 実座標 (edgeTrim + x, edgeTrim + y)、実寸は l × w。
  Placement2D には実座標・実寸基準の値（x, y は実座標左下角、rotated フラグ）を格納する。

## アルゴリズム（逐次型 MaxRects）

- 各シートは free rectangle のリストを持つ（初期値はビン全体 1 個）。
- 部材列を方式ごとのキーでソートし、1 個ずつ処理する。各部材について
  「開いているシート群 × free rect × 向き」の全候補から最良スコアの位置を選ぶ。
  どこにも入らなければ新しいシートを開く（＝必要枚数の自動決定）。
- 配置時、配置矩形（used）と交差する全 free rect を上下左右に最大 4 分割し、
  包含関係で刈り込む（prune）。
- rot: True の部材は 90° 回転（l↔w）候補も評価する。rot: False は原向きのみ。

浮動小数の等号成立判定は common.EPS で許容する。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from kidori.model import Part, Settings, Stock, effective_width
from kidori.packing.common import (
    EPS,
    PartInstance,
    Placement2D,
    StockUnit,
    usable_length,
)

Method2D = Literal["bssf", "baf", "bl"]


# ---------------------------------------------------------------------------
# 内部データ型（テスト用フックとして公開する。free rect の不変条件検査に用いる）
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Rect:
    """膨張座標系での軸並行矩形（free rect / used rect の表現）。"""

    x: float
    y: float
    w: float
    h: float

    @property
    def right(self) -> float:
        return self.x + self.w

    @property
    def top(self) -> float:
        return self.y + self.h

    def contains(self, other: "Rect") -> bool:
        """self が other を（EPS 許容で）完全に包含するかを返す。"""
        return (
            other.x >= self.x - EPS
            and other.y >= self.y - EPS
            and other.right <= self.right + EPS
            and other.top <= self.top + EPS
        )


@dataclass
class _Sheet:
    """1 枚のシート（原材）。free rect リストと膨張座標の配置記録を持つ。"""

    free_rects: list[Rect] = field(default_factory=list)
    # 配置記録: (インスタンス, 膨張x, 膨張y, 回転フラグ)
    placements: list[tuple[PartInstance, float, float, bool]] = field(
        default_factory=list
    )


# ---------------------------------------------------------------------------
# MaxRects コア: free rect の分割と刈り込み
# ---------------------------------------------------------------------------
def _split_free_rect(free: Rect, used: Rect) -> list[Rect]:
    """free を used で分割した新しい free rect 群を返す。

    Jylänki "A Thousand Ways to Pack the Bin" の SplitFreeNode に準拠する。
    used と交差しなければ free をそのまま返す。交差する場合は、used の下・上・左・右
    に残る帯状領域を（幅・高さが EPS を超えるもののみ）最大 4 個生成する。

    座標系は Y 上向き（部材ローカルと同じ左下原点）で、
    「下」= y 小さい側、「上」= y 大きい側。
    """
    # 交差なし判定（縁で接するだけは交差とみなさない）
    if (
        used.x >= free.right - EPS
        or used.right <= free.x + EPS
        or used.y >= free.top - EPS
        or used.top <= free.y + EPS
    ):
        return [free]

    result: list[Rect] = []

    def add(x: float, y: float, w: float, h: float) -> None:
        # 退化した（幅・高さが EPS 以下の）帯は捨てる
        if w > EPS and h > EPS:
            result.append(Rect(x, y, w, h))

    # X 方向に重なりがある → 下側・上側の帯を残す
    if used.x < free.right - EPS and used.right > free.x + EPS:
        # 下側（used の下端より下）
        if used.y > free.y + EPS:
            add(free.x, free.y, free.w, used.y - free.y)
        # 上側（used の上端より上）
        if used.top < free.top - EPS:
            add(free.x, used.top, free.w, free.top - used.top)

    # Y 方向に重なりがある → 左側・右側の帯を残す
    if used.y < free.top - EPS and used.top > free.y + EPS:
        # 左側（used の左端より左）
        if used.x > free.x + EPS:
            add(free.x, free.y, used.x - free.x, free.h)
        # 右側（used の右端より右）
        if used.right < free.right - EPS:
            add(used.right, free.y, free.right - used.right, free.h)

    return result


def _prune(rects: list[Rect]) -> list[Rect]:
    """他の free rect に完全包含される free rect を除去する（PruneFreeList）。

    包含関係にあるペアのうち、包含される側を 1 つだけ落とす。完全一致（相互包含）
    の場合も片方だけが残る（i < j の走査順により、決定的にリスト後方が残る）。
    """
    n = len(rects)
    removed = [False] * n
    for i in range(n):
        if removed[i]:
            continue
        for j in range(n):
            if i == j or removed[j]:
                continue
            # rects[j] が rects[i] を包含 → i を落とす
            if rects[j].contains(rects[i]):
                removed[i] = True
                break
    return [r for i, r in enumerate(rects) if not removed[i]]


def _place(sheet: _Sheet, used: Rect) -> None:
    """used を配置し、シートの free rect を分割・刈り込みで更新する。"""
    new_free: list[Rect] = []
    for fr in sheet.free_rects:
        new_free.extend(_split_free_rect(fr, used))
    sheet.free_rects = _prune(new_free)


# ---------------------------------------------------------------------------
# スコア関数・ソートキー（設計 §4 の表）
# ---------------------------------------------------------------------------
def _score(method: Method2D, fr: Rect, pw: float, ph: float) -> tuple[float, float]:
    """方式ごとの配置スコア（小さいほど良い）を (主, 副) で返す。

    - bssf: min(短辺残り), タイ: 長辺残り
    - baf : min(面積残り), タイ: 短辺残り
    - bl  : min(配置上端 y), タイ: min(x)
    """
    leftover_h = fr.w - pw
    leftover_v = fr.h - ph
    short_side = min(leftover_h, leftover_v)
    long_side = max(leftover_h, leftover_v)
    if method == "bssf":
        return (short_side, long_side)
    if method == "baf":
        return (fr.w * fr.h - pw * ph, short_side)
    if method == "bl":
        return (fr.y + ph, fr.x)
    raise ValueError(f"未知の 2D 割付方式: {method!r}")


def _sort_key(inst: PartInstance, stock: Stock, method: Method2D):
    """方式ごとの部材ソートキー（設計 §4 の表）。

    - bssf: 面積降順
    - baf : 最大辺降順
    - bl  : (幅, 長さ) 降順（同幅グループを連続させる）
    タイブレークは常に (part.id, instance.index) 昇順で決定的にする。
    """
    length = inst.part.length
    width = effective_width(inst.part, stock)
    if method == "bssf":
        return (-(length * width), inst.part.id, inst.index)
    if method == "baf":
        return (-max(length, width), inst.part.id, inst.index)
    if method == "bl":
        return (-width, -length, inst.part.id, inst.index)
    raise ValueError(f"未知の 2D 割付方式: {method!r}")


def _orientations(
    part: Part, stock: Stock, kerf: float
) -> list[tuple[float, float, bool]]:
    """膨張後の (幅, 高さ, 回転フラグ) 候補を返す。

    原向きは (l+kerf, w+kerf, False)。rot=True の場合のみ 90° 回転
    (w+kerf, l+kerf, True) を追加する。
    """
    length = part.length
    width = effective_width(part, stock)
    cands = [(length + kerf, width + kerf, False)]
    if part.rot:
        cands.append((width + kerf, length + kerf, True))
    return cands


# ---------------------------------------------------------------------------
# 候補探索
# ---------------------------------------------------------------------------
def _find_best(
    sheets: list[_Sheet],
    orientations: list[tuple[float, float, bool]],
    method: Method2D,
) -> tuple[int, Rect, float, float, bool] | None:
    """開いている全シート × free rect × 向き から最良候補を選ぶ。

    候補キー = (主スコア, 副スコア, free rect の y, x, シート番号, 回転フラグ)。
    最終タイブレークは (free rect の y, x, シート番号) 昇順で決定的にする
    （回転フラグは同座標同スコア時の最後の決定要素として原向きを優先）。

    Returns:
        (シート番号, 採用 free rect, 膨張幅 pw, 膨張高 ph, 回転フラグ)。
        どこにも入らなければ None。
    """
    best_key = None
    best: tuple[int, Rect, float, float, bool] | None = None
    for si, sheet in enumerate(sheets):
        for fr in sheet.free_rects:
            for pw, ph, rotated in orientations:
                if pw <= fr.w + EPS and ph <= fr.h + EPS:
                    primary, secondary = _score(method, fr, pw, ph)
                    key = (
                        primary,
                        secondary,
                        fr.y,
                        fr.x,
                        si,
                        1 if rotated else 0,
                    )
                    if best_key is None or key < best_key:
                        best_key = key
                        best = (si, fr, pw, ph, rotated)
    return best


# ---------------------------------------------------------------------------
# 公開エントリ
# ---------------------------------------------------------------------------
def _pack_2d_sheets(
    instances: list[PartInstance],
    stock: Stock,
    s: Settings,
    method: Method2D,
) -> list[_Sheet]:
    """MaxRects 本体。シート（free rect 付き）のリストを返す（テスト用フック）。

    free rect の不変条件検査など、内部状態を要するテストはこの関数を用いる。
    実配置の取得には pack_2d を使う。
    """
    kerf = s.kerf
    edge_trim = s.edge_trim
    length_u = usable_length(stock.length, edge_trim)  # Lu
    width_u = usable_length(stock.width, edge_trim)  # Wu
    bin_w = length_u + kerf
    bin_h = width_u + kerf
    if bin_w <= EPS or bin_h <= EPS:
        raise ValueError(
            f"原材 {stock.id!r} の使用可能窓が非正（edgeTrim 過大）: "
            f"Lu={length_u}, Wu={width_u}"
        )

    sorted_instances = sorted(
        instances, key=lambda inst: _sort_key(inst, stock, method)
    )

    sheets: list[_Sheet] = []
    for inst in sorted_instances:
        orientations = _orientations(inst.part, stock, kerf)
        best = _find_best(sheets, orientations, method)
        if best is None:
            # どの既存シートにも入らない → 新シートを開く
            sheets.append(_Sheet(free_rects=[Rect(0.0, 0.0, bin_w, bin_h)]))
            best = _find_best(sheets, orientations, method)
            if best is None:
                # 事前チェック（loader §2-3）が正しければ到達しない
                raise ValueError(
                    f"部材 {inst.instance_id!r} は原材 {stock.id!r} の"
                    "使用可能窓に収まりません（rot 指定と寸法を確認してください）"
                )
        si, fr, pw, ph, rotated = best
        sheet = sheets[si]
        _place(sheet, Rect(fr.x, fr.y, pw, ph))
        sheet.placements.append((inst, fr.x, fr.y, rotated))

    return sheets


def pack_2d(
    instances: list[PartInstance],
    stock: Stock,
    s: Settings,
    method: Method2D,
) -> list[StockUnit]:
    """sheet 原材への 2D 割付を行い、使用した StockUnit のリストを返す。

    Args:
        instances: qty 展開済みの部材インスタンス（同一 stock にバインドされた sheet 部材）。
        stock: 対象の原材（kind=="sheet" を想定）。
        s: 設定（kerf・edgeTrim を使用）。
        method: "bssf" / "baf" / "bl" のいずれか。

    Returns:
        使用したシートごとの StockUnit（index は 1 始まり）。各 Placement2D は
        実座標左下角 (x, y)・実寸基準・rotated フラグを持つ。
    """
    sheets = _pack_2d_sheets(instances, stock, s, method)
    edge_trim = s.edge_trim
    units: list[StockUnit] = []
    for i, sheet in enumerate(sheets):
        placements: list[Placement2D] = []
        for inst, x_exp, y_exp, rotated in sheet.placements:
            placements.append(
                Placement2D(
                    instance=inst,
                    x=edge_trim + x_exp,
                    y=edge_trim + y_exp,
                    rotated=rotated,
                )
            )
        # 決定的な順序（(y, x) 昇順）に整える。配置番号採番の前提と揃える。
        placements.sort(key=lambda p: (p.y, p.x))
        units.append(StockUnit(stock=stock, index=i + 1, placements=placements))
    return units
