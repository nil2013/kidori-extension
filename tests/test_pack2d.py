"""pack2d.py（MaxRects 2D 割付）の性質テスト（設計正本 §10-4）。

MaxRects の free rect 管理は誤実装の検出コストが高いため、個別座標のゴールデン比較
ではなく不変条件（性質）で正しさを担保する。Part/PartInstance はこのファイル内で
直接構築する（conftest.py には依存しない）。
"""

from __future__ import annotations

import pytest

from kidori.model import Part, Settings, Stock, effective_width
from kidori.packing.common import PartInstance, Placement2D, StockUnit
from kidori.packing.pack2d import (
    Rect,
    _pack_2d_sheets,
    pack_2d,
)

EPS = 1e-6  # テスト側の許容誤差（実装側 EPS=1e-9 より緩く取る）


# ---------------------------------------------------------------------------
# ビルダ / 補助
# ---------------------------------------------------------------------------
def make_stock(
    id: str = "sheet-1",
    length: float = 1820.0,
    width: float = 910.0,
    thickness: float = 18.0,
    price: float | None = None,
) -> Stock:
    return Stock(
        id=id,
        label=id,
        kind="sheet",
        length=length,
        width=width,
        thickness=thickness,
        price=price,
    )


def make_part(
    id: str,
    length: float,
    width: float,
    rot: bool = True,
    qty: int = 1,
    stock: str = "sheet-1",
) -> Part:
    return Part(
        id=id,
        label=id,
        qty=qty,
        stock=stock,
        length=length,
        width=width,
        rot=rot,
        features=(),
    )


def instances_of(*parts: Part) -> list[PartInstance]:
    """各 Part を qty 展開して PartInstance のリストにする。"""
    out: list[PartInstance] = []
    for p in parts:
        for i in range(1, p.qty + 1):
            out.append(PartInstance(part=p, index=i))
    return out


def settings(kerf: float = 3.0, edge_trim: float = 5.0) -> Settings:
    return Settings(kerf=kerf, edge_trim=edge_trim, candidates=3, selected_plan=None)


def real_footprint(p: Placement2D, stock: Stock) -> tuple[float, float, float, float]:
    """配置の実座標フットプリント (x0, y0, x1, y1) を返す。"""
    length = p.instance.part.length
    width = effective_width(p.instance.part, stock)
    if p.rotated:
        fw, fh = width, length
    else:
        fw, fh = length, width
    return (p.x, p.y, p.x + fw, p.y + fh)


def all_placements(units: list[StockUnit]) -> list[Placement2D]:
    out: list[Placement2D] = []
    for u in units:
        out.extend(u.placements)
    return out


def placement_signature(units: list[StockUnit]) -> list[tuple]:
    """決定性比較用の正規化シグネチャ。"""
    sig: list[tuple] = []
    for u in units:
        for p in u.placements:
            sig.append(
                (u.index, p.instance.instance_id, round(p.x, 6), round(p.y, 6), p.rotated)
            )
    return sig


# ---------------------------------------------------------------------------
# 性質1: 全配置が使用可能窓 [e, L-e] × [e, W-e] 内（実座標）
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("method", ["bssf", "baf", "bl"])
def test_all_placements_within_usable_window(method):
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=3.0, edge_trim=5.0)
    parts = [
        make_part("a", 400, 200),
        make_part("b", 300, 250),
        make_part("c", 500, 180),
        make_part("d", 200, 200),
    ]
    units = pack_2d(instances_of(*parts), stock, s, method)
    e = s.edge_trim
    x_lo, x_hi = e, stock.length - e
    y_lo, y_hi = e, stock.width - e
    for p in all_placements(units):
        x0, y0, x1, y1 = real_footprint(p, stock)
        assert x0 >= x_lo - EPS, f"{p.instance.instance_id} が左窓外: x0={x0}"
        assert y0 >= y_lo - EPS, f"{p.instance.instance_id} が下窓外: y0={y0}"
        assert x1 <= x_hi + EPS, f"{p.instance.instance_id} が右窓外: x1={x1}"
        assert y1 <= y_hi + EPS, f"{p.instance.instance_id} が上窓外: y1={y1}"


# ---------------------------------------------------------------------------
# 性質2: 任意の2部材で x 投影か y 投影が分離し、離間 ≥ kerf（実座標）
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("method", ["bssf", "baf", "bl"])
@pytest.mark.parametrize("kerf", [0.0, 3.0, 5.5])
def test_pairwise_separation_at_least_kerf(method, kerf):
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=kerf, edge_trim=5.0)
    parts = [
        make_part("a", 400, 200),
        make_part("b", 300, 250),
        make_part("c", 500, 180),
        make_part("d", 250, 220),
        make_part("e", 180, 180),
    ]
    units = pack_2d(instances_of(*parts), stock, s, method)
    placements = all_placements(units)
    # 同一シート内のペアのみ検査（別シートは自明に分離）
    by_unit: dict[int, list[Placement2D]] = {}
    for u in units:
        by_unit[u.index] = u.placements
    for plist in by_unit.values():
        for i in range(len(plist)):
            for j in range(i + 1, len(plist)):
                ax0, ay0, ax1, ay1 = real_footprint(plist[i], stock)
                bx0, by0, bx1, by1 = real_footprint(plist[j], stock)
                sep_x = (bx0 - ax1 >= kerf - EPS) or (ax0 - bx1 >= kerf - EPS)
                sep_y = (by0 - ay1 >= kerf - EPS) or (ay0 - by1 >= kerf - EPS)
                assert sep_x or sep_y, (
                    f"{plist[i].instance.instance_id} と "
                    f"{plist[j].instance.instance_id} の離間が kerf 未満"
                )


# ---------------------------------------------------------------------------
# 性質3: rot:false は回転しない / rot:true では回転が起きうる
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("method", ["bssf", "baf", "bl"])
def test_rot_false_never_rotates(method):
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=3.0, edge_trim=5.0)
    # 原向きで素直に収まる部材群（全て rot=False）
    parts = [
        make_part("a", 400, 200, rot=False),
        make_part("b", 300, 250, rot=False),
        make_part("c", 200, 200, rot=False),
    ]
    units = pack_2d(instances_of(*parts), stock, s, method)
    for p in all_placements(units):
        assert p.rotated is False, f"{p.instance.instance_id} が回転してしまった"


@pytest.mark.parametrize("method", ["bssf", "baf", "bl"])
def test_rot_true_rotates_when_only_rotation_fits(method):
    # 窓の高さ Wu が部材幅より小さく、原向きでは入らない → 回転が強制される。
    # L=1000, W=200, e=5, kerf=0 → Lu=990, Wu=190。
    # 部材 length=150(<=190), width=250(>190,<=990)。原向き ph=250>190 で不可、
    # 回転 ph=150<=190, pw=250<=990 で可。
    stock = make_stock(length=1000, width=200)
    s = settings(kerf=0.0, edge_trim=5.0)
    part = make_part("tall", length=150, width=250, rot=True)
    units = pack_2d(instances_of(part), stock, s, method)
    placements = all_placements(units)
    assert len(placements) == 1
    assert placements[0].rotated is True, "回転しないと収まらないのに原向きで配置された"
    # 実座標フットプリントが窓内であることも確認
    x0, y0, x1, y1 = real_footprint(placements[0], stock)
    assert x0 >= 5 - EPS and y0 >= 5 - EPS
    assert x1 <= 1000 - 5 + EPS and y1 <= 200 - 5 + EPS


def test_rot_false_only_rotation_fits_raises():
    # 上と同寸だが rot=False → どの向きでも入らず ValueError。
    stock = make_stock(length=1000, width=200)
    s = settings(kerf=0.0, edge_trim=5.0)
    part = make_part("tall", length=150, width=250, rot=False)
    with pytest.raises(ValueError):
        pack_2d(instances_of(part), stock, s, "bssf")


# ---------------------------------------------------------------------------
# 性質4: 必要枚数の自動増加
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("method", ["bssf", "baf", "bl"])
def test_sheet_count_increases_when_overflow(method):
    # 1枚には 1 個しか入らない大部材を 2 個 → 2 枚に分かれる。
    # L=1000, W=600, e=5 → Lu=990, Wu=590。
    # 部材 length=980, width=400。高さ方向に 2 個は 400*2=800 > 590 で不可 → 2 枚目。
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=3.0, edge_trim=5.0)
    part = make_part("big", length=980, width=400, rot=False, qty=2)
    units = pack_2d(instances_of(part), stock, s, method)
    assert len(units) == 2, f"2 枚に分かれるはずが {len(units)} 枚"
    assert sum(len(u.placements) for u in units) == 2
    # 各シートに 1 個ずつ
    assert all(len(u.placements) == 1 for u in units)


@pytest.mark.parametrize("method", ["bssf", "baf", "bl"])
def test_single_sheet_when_fits(method):
    # 小部材群は 1 枚に収まる。
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=3.0, edge_trim=5.0)
    parts = [make_part(f"p{i}", 150, 150) for i in range(4)]
    units = pack_2d(instances_of(*parts), stock, s, method)
    assert len(units) == 1
    assert len(units[0].placements) == 4


# ---------------------------------------------------------------------------
# 性質5: free rect の不変条件（重複包含なし）
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("method", ["bssf", "baf", "bl"])
def test_free_rect_no_mutual_containment(method):
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=3.0, edge_trim=5.0)
    parts = [
        make_part("a", 400, 200),
        make_part("b", 300, 250),
        make_part("c", 500, 180),
        make_part("d", 250, 220),
        make_part("e", 180, 180),
        make_part("f", 220, 300),
    ]
    sheets = _pack_2d_sheets(instances_of(*parts), stock, s, method)
    for sheet in sheets:
        frs = sheet.free_rects
        for i in range(len(frs)):
            for j in range(len(frs)):
                if i == j:
                    continue
                # 相互包含（＝重複を残す刈り込み漏れ）がないこと
                assert not frs[i].contains(frs[j]), (
                    f"free rect {j} が {i} に包含されている（刈り込み漏れ）"
                )


def test_free_rects_have_positive_area():
    # 退化した（面積ゼロ近傍の）free rect が残らないこと。
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=3.0, edge_trim=5.0)
    parts = [make_part("a", 400, 200), make_part("b", 600, 400)]
    sheets = _pack_2d_sheets(instances_of(*parts), stock, s, "bssf")
    for sheet in sheets:
        for fr in sheet.free_rects:
            assert fr.w > 0 and fr.h > 0


# ---------------------------------------------------------------------------
# 性質6: 3方式の決定性と、方式間で結果が異なりうること
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("method", ["bssf", "baf", "bl"])
def test_determinism(method):
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=3.0, edge_trim=5.0)
    parts = [
        make_part("a", 400, 200),
        make_part("b", 300, 250),
        make_part("c", 500, 180),
        make_part("d", 250, 220),
        make_part("e", 180, 180),
    ]
    insts = instances_of(*parts)
    sig1 = placement_signature(pack_2d(insts, stock, s, method))
    sig2 = placement_signature(pack_2d(insts, stock, s, method))
    assert sig1 == sig2, f"方式 {method} が非決定的"


def test_methods_can_differ():
    # 異なる縦横比の部材を混ぜると、ソート順・スコアの違いで配置が変わる。
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=3.0, edge_trim=5.0)
    parts = [
        make_part("wide", 100, 300),
        make_part("tall", 300, 100),
        make_part("square", 200, 200),
        make_part("long", 500, 150),
    ]
    insts = instances_of(*parts)
    sig_bssf = placement_signature(pack_2d(insts, stock, s, "bssf"))
    sig_bl = placement_signature(pack_2d(insts, stock, s, "bl"))
    # 少なくとも 1 ペアの方式で配置結果が異なること（人が比較する意味がある）
    assert sig_bssf != sig_bl, "bssf と bl で配置が完全一致（方式差が出ていない）"


# ---------------------------------------------------------------------------
# 性質7: 膨張座標系の縁配置（§10-5 の 2D カット回数の前提となる配置検証）
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("method", ["bssf", "bl"])
def test_first_placement_sits_on_window_corner(method):
    # 最初に置かれる部材は膨張座標 (0,0) → 実座標 (e, e)、窓の左下隅に接する。
    # これは「窓境界に載る辺には縁カットで足りる（追加カット不要）」という
    # §10-5 のカット回数定義の前提になる配置性質。
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=3.0, edge_trim=5.0)
    parts = [make_part("a", 400, 200), make_part("b", 300, 250)]
    units = pack_2d(instances_of(*parts), stock, s, method)
    # 全配置のうち窓左下隅 (e, e) に載るものが少なくとも1つ存在する
    e = s.edge_trim
    on_corner = [
        p for p in all_placements(units) if abs(p.x - e) < EPS and abs(p.y - e) < EPS
    ]
    assert on_corner, "窓左下隅に接する配置が無い（膨張座標原点の実座標復元が不正の疑い）"


def test_placement_edges_align_to_window_when_full_width():
    # 窓幅いっぱいの部材は上端が窓上境界 W-e に一致する（縁カットで賄える辺）。
    # L=1000, W=210, e=5, kerf=0 → Wu=200。width=200 の部材は y0=e, y1=W-e=205。
    stock = make_stock(length=1000, width=210)
    s = settings(kerf=0.0, edge_trim=5.0)
    part = make_part("full", length=300, width=200, rot=False)
    units = pack_2d(instances_of(part), stock, s, "bssf")
    p = all_placements(units)[0]
    x0, y0, x1, y1 = real_footprint(p, stock)
    assert abs(y0 - 5) < EPS
    assert abs(y1 - (210 - 5)) < EPS


# ---------------------------------------------------------------------------
# 追加: 膨張座標系の境界（回転すれば入る/入らないの厳密境界、§10-4 の詰め込み可否）
# ---------------------------------------------------------------------------
def test_exact_fit_of_window():
    # 部材が使用可能窓ぴったり（Lu×Wu）に収まる境界ケース。
    # L=1000, W=600, e=5, kerf=3 → Lu=990, Wu=590。ビン=(993)×(593)。
    # 部材 length=990, width=590 → 膨張 993×593 = ビン全体。等号成立で 1 枚に収まる。
    stock = make_stock(length=1000, width=600)
    s = settings(kerf=3.0, edge_trim=5.0)
    part = make_part("exact", length=990, width=590, rot=False)
    units = pack_2d(instances_of(part), stock, s, "bssf")
    assert len(units) == 1
    p = all_placements(units)[0]
    x0, y0, x1, y1 = real_footprint(p, stock)
    assert abs(x0 - 5) < EPS and abs(y0 - 5) < EPS
    assert abs(x1 - 995) < EPS and abs(y1 - 595) < EPS
