"""1D 木取り（長尺材の割付）3方式の実装。

設計正本（.claude/logs/2026-07-22-design.md）§3 準拠（2026-07-22 改訂反映）。
kerf・edgeTrim の容量判定・座標計算はすべて packing.common の
fits_1d / usable_length / EPS を経由し、本モジュールでは独自の
容量判定・epsilon を定義しない。

3方式:
    - ffd: 長さ降順に、開いた順で最初に入る原材へ配置する（FFD）。
    - bfd: 長さ降順に、配置後の残り有効長が最小になる原材へ配置する（BFD）。
        タイブレークは先に開いた原材を優先する。
    - grouped（グループ充填型）: 長さ降順・同長連続で処理し、
        各同長グループ（長さ x、残数 k）ごとに:
            1. 既に x を含み容量のある原材（開いた順）へ入るだけ配置する（top-up）。
            2. 残数 ≥ 2 の間: 新規原材を開き、入るだけ x を配置する。
               ただし新品1本に入る最大数 c == 1 なら手順 3 へ。
            3. 残り（1 個、または c==1 の場合の全部材）: 1 個ずつ FFD
               （既存原材の開いた順で最初に入る所、なければ新規）。
        歩留まりを犠牲に同長部材を同一原材へ集約し、丸鋸ストッパーでの
        連続カット（作業性）を優先する。FFD/BFD と明確に異なる結果を生む。
        〔当初案（①同長優先→②FFD→③新規）は、同長部材が降順ソートで必ず
        連続処理されるため任意入力で FFD と同一出力になることが証明され、
        本方式に差し替えられた（設計正本 §3 の改訂注記を参照）。〕

いずれの方式も、収まる原材が既存に無ければ新規原材を無制限に開く
（必要本数の自動決定）。空の1本にも入らない部材は意味検証層（loader.py）で
事前に弾かれる前提であり、本モジュールはその防御を行わない。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from kidori.model import Settings, Stock
from kidori.packing.common import EPS, PartInstance, Placement1D, StockUnit, fits_1d, usable_length


@dataclass
class _UnitState:
    """原材1本ぶんの割付進行状態（内部ヘルパ。公開契約ではない）。

    Attributes:
        used_len: fits_1d に渡す「これまでに配置した部材長合計（既に消費した
            内部 kerf を含む）」。common.fits_1d の used_len 引数と同じ定義。
        count: これまでにこの原材へ配置した部材の個数。
        placements: 確定済みの配置一覧（挿入順 = start 昇順）。
    """

    used_len: float = 0.0
    count: int = 0
    placements: list[Placement1D] = field(default_factory=list)

    def has_length(self, length: float) -> bool:
        """この原材に既に同じ長さ（EPS 許容）の部材が配置済みかを返す。"""
        return any(
            abs(p.instance.part.length - length) <= EPS for p in self.placements
        )


def _sort_key(instance: PartInstance) -> tuple[float, str, int]:
    """§3 のソート規約: 主キー part.length 降順、タイブレーク (part.id, instance.index) 昇順。"""
    return (-instance.part.length, instance.part.id, instance.index)


def _place(unit: _UnitState, instance: PartInstance, s: Settings) -> None:
    """原材 unit の末尾に instance を配置し、進行状態を更新する。

    座標は §3 の規約 o_1 = edgeTrim、o_{i+1} = o_i + len_i + kerf に従う。
    `start = edgeTrim + used_len + (kerf if count>0 else 0)` は count==0 のとき
    used_len==0 で edgeTrim = o_1 に一致し、以降は帰納的に o_{i+1} と一致する。
    """
    start = s.edge_trim + unit.used_len + (s.kerf if unit.count > 0 else 0.0)
    unit.placements.append(Placement1D(instance=instance, start=start))
    unit.used_len = (
        unit.used_len + (s.kerf if unit.count > 0 else 0.0) + instance.part.length
    )
    unit.count += 1


def _find_ffd_target(
    units: list[_UnitState], length: float, kerf: float, usable: float
) -> int | None:
    """FFD: 開いた順（index 昇順）で最初に収まる原材の位置を返す。無ければ None。"""
    for i, u in enumerate(units):
        if fits_1d(u.used_len, u.count, length, kerf, usable):
            return i
    return None


def _find_bfd_target(
    units: list[_UnitState], length: float, kerf: float, usable: float
) -> int | None:
    """BFD: 配置後の残り有効長が最小になる原材の位置を返す。無ければ None。

    タイブレークは先に開いた原材（index が小さい方）を優先する。
    ループは index 昇順に進み、「厳密に」より小さい残りにのみ更新するため、
    同点（EPS 以内）では先勝ちが自然に保たれる。
    """
    best_i: int | None = None
    best_remaining: float | None = None
    for i, u in enumerate(units):
        if not fits_1d(u.used_len, u.count, length, kerf, usable):
            continue
        needed = u.used_len + (kerf if u.count > 0 else 0.0) + length
        remaining = usable - needed
        if best_remaining is None or remaining < best_remaining - EPS:
            best_remaining = remaining
            best_i = i
    return best_i


def _fresh_unit_capacity(length: float, kerf: float, usable: float) -> int:
    """新品の原材1本に長さ length の部材が最大何個入るか（c）を返す。

    容量判定は fits_1d の反復のみで行う（独自の算術式は使わない）。
    length > 0 は意味検証層で担保される前提（ループは必ず停止する）。
    """
    used = 0.0
    count = 0
    while fits_1d(used, count, length, kerf, usable):
        used = used + (kerf if count > 0 else 0.0) + length
        count += 1
    return count


def _pack_grouped(
    sorted_instances: list[PartInstance], s: Settings, usable: float
) -> list[_UnitState]:
    """案C（グループ充填型）の本体。§3 改訂版の手順 1〜3 を同長グループごとに適用する。

    sorted_instances は _sort_key で整列済みであることを前提とする
    （同長部材は必ず連続し、グループ内の順序は (part.id, instance.index) 昇順）。
    """
    kerf = s.kerf
    units: list[_UnitState] = []

    i = 0
    n = len(sorted_instances)
    while i < n:
        # 同長グループの切り出し（長さの一致判定は EPS 許容）。
        x = sorted_instances[i].part.length
        j = i
        while j < n and abs(sorted_instances[j].part.length - x) <= EPS:
            j += 1
        group = sorted_instances[i:j]
        i = j

        pos = 0  # グループ内の未配置先頭位置

        # 手順1: 既に x を含み容量のある原材（開いた順）へ入るだけ配置（top-up）。
        for u in units:
            if pos >= len(group):
                break
            if not u.has_length(x):
                continue
            while pos < len(group) and fits_1d(u.used_len, u.count, x, kerf, usable):
                _place(u, group[pos], s)
                pos += 1

        # 手順2: 残数 ≥ 2 の間、新規原材を開いて入るだけ配置。
        # ただし新品1本に1個しか入らない（c == 1）場合は手順3へ委ねる
        # （1本1個の新規開設は FFD と同じ結果にしかならず、既存原材の
        #  端材再利用の機会を失うだけのため）。
        c = _fresh_unit_capacity(x, kerf, usable)
        if c >= 2:
            while len(group) - pos >= 2:
                u = _UnitState()
                units.append(u)
                while pos < len(group) and fits_1d(u.used_len, u.count, x, kerf, usable):
                    _place(u, group[pos], s)
                    pos += 1

        # 手順3: 残り（1個、または c==1 の場合の全部材）を1個ずつ FFD。
        while pos < len(group):
            idx = _find_ffd_target(units, x, kerf, usable)
            if idx is None:
                units.append(_UnitState())
                idx = len(units) - 1
            _place(units[idx], group[pos], s)
            pos += 1

    return units


# ffd / bfd の原材選択関数（grouped は _pack_grouped が専用ルーチンで処理する）。
_FINDERS = {
    "ffd": _find_ffd_target,
    "bfd": _find_bfd_target,
}


def pack_1d(
    instances: list[PartInstance],
    stock: Stock,
    s: Settings,
    method: Literal["ffd", "bfd", "grouped"],
) -> list[StockUnit]:
    """1D 木取りを実行し、使用した原材（StockUnit）一覧を返す。

    Args:
        instances: qty 展開済みの部材インスタンス一覧（呼び出し側が展開済み。
            本トラックのテストでは自前で展開する）。全て stock.kind=="bar" を
            前提とする（kind の検証はここでは行わない）。
        stock: 対象の原材定義。
        s: settings（kerf・edge_trim を使用）。
        method: "ffd" / "bfd" / "grouped"。

    Returns:
        使用順（StockUnit.index=1始まり、開いた順）の StockUnit 一覧。
        各 StockUnit.placements は Placement1D のリストで、start 昇順に確定済み。
    """
    usable = usable_length(stock.length, s.edge_trim)
    sorted_instances = sorted(instances, key=_sort_key)

    if method == "grouped":
        units = _pack_grouped(sorted_instances, s, usable)
    else:
        finder = _FINDERS[method]
        units = []
        for instance in sorted_instances:
            length = instance.part.length
            target_idx = finder(units, length, s.kerf, usable)
            if target_idx is None:
                units.append(_UnitState())
                target_idx = len(units) - 1
            _place(units[target_idx], instance, s)

    return [
        StockUnit(stock=stock, index=idx, placements=list(u.placements))
        for idx, u in enumerate(units, start=1)
    ]
