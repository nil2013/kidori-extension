"""packing.pack1d の単体テスト。

設計正本（.claude/logs/2026-07-22-design.md）§3・§10-1/3/5 に対応する。
conftest.py は Track A（loader/schema）の所有物のため、本ファイルは一切依存せず
Part/PartInstance/Stock/Settings をすべて自前で構築する。

kerf/edgeTrim の容量判定は kidori.packing.common の fits_1d / usable_length / EPS
を検証の基準として用い、本ファイルでは独自の epsilon・容量判定式を書かない。
"""

from __future__ import annotations

from kidori.model import Part, Settings, Stock
from kidori.packing.common import (
    PartInstance,
    StockUnit,
    cut_count_1d,
    fits_1d,
    usable_length,
)
from kidori.packing.pack1d import pack_1d


# ---------------------------------------------------------------------------
# テスト用ヘルパ（conftest.py は使わず、本ファイル内に閉じる）
# ---------------------------------------------------------------------------


def make_stock(length: float, stock_id: str = "bar-1", width: float = 89.0) -> Stock:
    """bar 種別の Stock を1個組み立てる。"""
    return Stock(
        id=stock_id,
        label=f"テスト材 {stock_id}",
        kind="bar",
        length=length,
        width=width,
        thickness=19.0,
        price=None,
    )


def make_part(part_id: str, length: float, qty: int = 1, stock_id: str = "bar-1") -> Part:
    """bar 部材を1個組み立てる（width は省略＝ stock.width を使う想定）。"""
    return Part(
        id=part_id,
        label=f"部材 {part_id}",
        qty=qty,
        stock=stock_id,
        length=length,
    )


def instances_of(part: Part) -> list[PartInstance]:
    """qty 展開: PartInstance(part, 1..qty) を生成する（本トラックのテストでは自前展開）。"""
    return [PartInstance(part=part, index=i) for i in range(1, part.qty + 1)]


def flatten_starts(units: list[StockUnit]) -> list[tuple[int, str, float]]:
    """StockUnit 一覧を (unit.index, instance_id, start) のタプル列に平坦化する（比較用）。"""
    result = []
    for u in units:
        for p in u.placements:
            result.append((u.index, p.instance.instance_id, p.start))
    return result


# ---------------------------------------------------------------------------
# §10-1: kerf/edgeTrim 境界（1D）
# ---------------------------------------------------------------------------


def test_boundary_equality_fits_in_one_unit():
    """Σlen + (n-1)*kerf == U ちょうどのとき、1本に収まる（等号成立を許容）。"""
    s = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)  # U = 100 - 2*5 = 90
    part = make_part("p", length=28.0, qty=3)  # 28*3 + 2*3 = 90 == U
    units = pack_1d(instances_of(part), stock, s, "ffd")

    assert len(units) == 1
    assert units[0].index == 1
    assert len(units[0].placements) == 3

    starts = sorted(p.start for p in units[0].placements)
    assert starts == [5.0, 36.0, 67.0]  # o1=5, o2=5+28+3=36, o3=36+28+3=67
    last = max(units[0].placements, key=lambda p: p.start)
    end = last.start + last.instance.part.length
    assert abs(end - 95.0) < 1e-9  # E == L - edgeTrim == 95、有効長の限界に一致


def test_boundary_plus_0_1_opens_second_unit():
    """境界値に +0.1 すると2本目が開く。"""
    s = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)  # U = 90
    # 3本のうち1本だけ +0.1（28.1, 28, 28）。合計 = 84.1 + 6 = 90.1 > 90。
    part_big = make_part("big", length=28.1, qty=1)
    part_rest = make_part("rest", length=28.0, qty=2)
    instances = instances_of(part_big) + instances_of(part_rest)

    units = pack_1d(instances, stock, s, "ffd")

    assert len(units) == 2
    # 長さ降順で処理: 28.1(新規unit1) → 28(unit1に入る, needed=59.1<=90) →
    # 28(unit1に入らない, needed=90.1>90 → unit2を新規に開く)
    assert len(units[0].placements) == 2
    assert len(units[1].placements) == 1


def test_boundary_kerf_zero():
    """kerf=0 のとき、部材間に隙間なく詰められる。"""
    s = Settings(kerf=0.0, edge_trim=5.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)  # U = 90
    part = make_part("p", length=30.0, qty=3)  # 30*3 + 0 = 90 == U

    units = pack_1d(instances_of(part), stock, s, "ffd")

    assert len(units) == 1
    starts = sorted(p.start for p in units[0].placements)
    assert starts == [5.0, 35.0, 65.0]  # kerf=0 のため隙間なく連続
    last = max(units[0].placements, key=lambda p: p.start)
    end = last.start + last.instance.part.length
    assert abs(end - 95.0) < 1e-9


def test_boundary_edge_trim_zero():
    """edgeTrim=0 のとき、先頭配置が生端 (start=0) から始まる。"""
    s = Settings(kerf=3.0, edge_trim=0.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)  # U = 100
    part = make_part("p", length=100.0, qty=1)  # ちょうど全長を使い切る

    units = pack_1d(instances_of(part), stock, s, "ffd")

    assert len(units) == 1
    assert units[0].placements[0].start == 0.0
    end = units[0].placements[0].start + part.length
    assert abs(end - 100.0) < 1e-9  # E == L


def test_boundary_kerf_and_edge_trim_both_zero():
    """kerf=0 かつ edgeTrim=0 の組合せ: 生端から生端まで隙間なく詰める。"""
    s = Settings(kerf=0.0, edge_trim=0.0, candidates=3, selected_plan=None)
    stock = make_stock(length=50.0)  # U = 50
    part = make_part("p", length=25.0, qty=2)  # 25*2 + 0 = 50 == U

    units = pack_1d(instances_of(part), stock, s, "ffd")

    assert len(units) == 1
    starts = sorted(p.start for p in units[0].placements)
    assert starts == [0.0, 25.0]
    last = max(units[0].placements, key=lambda p: p.start)
    end = last.start + last.instance.part.length
    assert abs(end - 50.0) < 1e-9  # E == L（末尾カット省略の前提条件）

    # このケースは cut_count_1d の「edgeTrim=0 かつ kerf=0」境界も兼ねる。
    cc = cut_count_1d(units[0].placements, stock, s)
    assert cc == 1  # leading=0 + interior(n-1=1) + trailing=0(edgeTrim=0 かつ E==L)


# ---------------------------------------------------------------------------
# §10-3: FFD/BFD 分岐フィクスチャ、grouped の同長隣接、決定性
# ---------------------------------------------------------------------------


def test_ffd_bfd_diverge_on_known_fixture():
    """FFD と BFD が異なる配置結果になる既知フィクスチャ。

    kerf=0, edgeTrim=0, stock.length=10 (U=10)。部材長 [8, 5, 4, 1]（降順処理）。

    手計算（監査用）:
      1) len=8  -> 既存原材なし -> Unit1 新規。Unit1.used=8, count=1。
      2) len=5  -> Unit1: needed=8+0+5=13>10 で不適合 -> Unit2 新規。Unit2.used=5, count=1。
      3) len=4  -> Unit1: needed=8+0+4=12>10 不適合。
                   Unit2: needed=5+0+4=9<=10 適合（他に選択肢なし）-> Unit2 に配置。
                   Unit2.used=9, count=2。
      4) len=1  -> ここで両原材とも適合する分岐点:
                   Unit1: needed=8+0+1=9<=10 適合。
                   Unit2: needed=9+0+1=10<=10 適合（ちょうど）。
         FFD: 開いた順（Unit1が先）に最初に適合したものを採用 -> Unit1 に配置。
              Unit1 = [8@0, 1@8]（used=9）、Unit2 = [5@0, 4@5]（used=9）。
         BFD: 配置後の残り有効長が最小になる方を採用
              (Unit1採用時の残り=10-9=1、Unit2採用時の残り=10-10=0 で Unit2 が最小)
              -> Unit2 に配置。
              Unit1 = [8@0]（used=8）、Unit2 = [5@0, 4@5, 1@9]（used=10）。
    """
    s = Settings(kerf=0.0, edge_trim=0.0, candidates=3, selected_plan=None)
    stock = make_stock(length=10.0)

    p8 = make_part("p8", length=8.0, qty=1)
    p5 = make_part("p5", length=5.0, qty=1)
    p4 = make_part("p4", length=4.0, qty=1)
    p1 = make_part("p1", length=1.0, qty=1)
    instances = (
        instances_of(p8) + instances_of(p5) + instances_of(p4) + instances_of(p1)
    )

    ffd_units = pack_1d(instances, stock, s, "ffd")
    bfd_units = pack_1d(instances, stock, s, "bfd")

    # FFD 期待結果
    assert len(ffd_units) == 2
    ffd_unit1 = next(u for u in ffd_units if u.index == 1)
    ffd_unit2 = next(u for u in ffd_units if u.index == 2)
    assert {(p.instance.instance_id, p.start) for p in ffd_unit1.placements} == {
        ("p8#1", 0.0),
        ("p1#1", 8.0),
    }
    assert {(p.instance.instance_id, p.start) for p in ffd_unit2.placements} == {
        ("p5#1", 0.0),
        ("p4#1", 5.0),
    }

    # BFD 期待結果（p1 の配置先が FFD と異なる = 分岐の証拠）
    assert len(bfd_units) == 2
    bfd_unit1 = next(u for u in bfd_units if u.index == 1)
    bfd_unit2 = next(u for u in bfd_units if u.index == 2)
    assert {(p.instance.instance_id, p.start) for p in bfd_unit1.placements} == {
        ("p8#1", 0.0),
    }
    assert {(p.instance.instance_id, p.start) for p in bfd_unit2.placements} == {
        ("p5#1", 0.0),
        ("p4#1", 5.0),
        ("p1#1", 9.0),
    }

    # 明示的に FFD != BFD であることを確認する。
    assert flatten_starts(ffd_units) != flatten_starts(bfd_units)


def test_grouped_diverges_from_ffd_on_known_fixture():
    """grouped（グループ充填型）と FFD が異なる本数・配置になる既知フィクスチャ。

    kerf=0, edgeTrim=0, stock.length=100 (U=100)。部材長 [60, 55, 40, 40, 40, 40]。

    手計算（監査用）:
      FFD（長さ降順に first-fit）:
        60 -> Unit1(used=60)
        55 -> Unit1: 60+55=115>100 不適合 -> Unit2(used=55)
        40 -> Unit1: 60+40=100<=100 適合 -> Unit1=[60@0, 40@60]
        40 -> Unit1 満杯, Unit2: 55+40=95<=100 -> Unit2=[55@0, 40@55]
        40 -> Unit1/Unit2 不適合 -> Unit3(40@0)
        40 -> Unit3: 40+40=80<=100 -> Unit3=[40@0, 40@40]
        => 3本: [60,40], [55,40], [40,40]

      grouped（同長グループごとに手順1〜3）:
        グループ60 (k=1): 手順1 該当なし。手順2 k<2 スキップ。手順3 FFD ->
            既存なし -> Unit1=[60@0]
        グループ55 (k=1): 手順3 FFD -> Unit1: 115>100 不適合 -> Unit2=[55@0]
        グループ40 (k=4): 手順1 40を含む原材なし。
            手順2: c（新品1本の最大数）= 2（40+40=80<=100, +40=120>100）>= 2。
              残4>=2 -> Unit3 新規に 40@0, 40@40（3個目 120>100 で停止）。残2。
              残2>=2 -> Unit4 新規に 40@0, 40@40。残0。
        => 4本: [60], [55], [40,40], [40,40]

    歩留まりでは FFD（3本）が優るが、grouped は同長4個を2本の原材へ集約し
    連続カット向きの配置になる（設計 §3 改訂版のとおりの分岐）。
    """
    s = Settings(kerf=0.0, edge_trim=0.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)
    p60 = make_part("p60", length=60.0, qty=1)
    p55 = make_part("p55", length=55.0, qty=1)
    p40 = make_part("p40", length=40.0, qty=4)
    instances = instances_of(p60) + instances_of(p55) + instances_of(p40)

    ffd_units = pack_1d(instances, stock, s, "ffd")
    grouped_units = pack_1d(instances, stock, s, "grouped")

    # FFD: 3本
    assert len(ffd_units) == 3
    assert flatten_starts(ffd_units) == [
        (1, "p60#1", 0.0),
        (1, "p40#1", 60.0),
        (2, "p55#1", 0.0),
        (2, "p40#2", 55.0),
        (3, "p40#3", 0.0),
        (3, "p40#4", 40.0),
    ]

    # grouped: 4本（同長40×4 が Unit3/Unit4 に2個ずつ集約される）
    assert len(grouped_units) == 4
    assert flatten_starts(grouped_units) == [
        (1, "p60#1", 0.0),
        (2, "p55#1", 0.0),
        (3, "p40#1", 0.0),
        (3, "p40#2", 40.0),
        (4, "p40#3", 0.0),
        (4, "p40#4", 40.0),
    ]

    # 明示的に分岐していることを確認する。
    assert flatten_starts(ffd_units) != flatten_starts(grouped_units)


def test_grouped_keeps_same_length_parts_adjacent():
    """grouped: 同じ長さの部材が同じ原材に隣接して集まる（同長隣接）。

    kerf=2, edgeTrim=0, stock.length=100 (U=100)。長さ30の部材が4個。
    グループ30 (k=4): 手順1 該当なし。手順2: c=3（30*3+2*2=94<=100、
    4個目は 94+2+30=126>100）>= 2 -> 残4>=2 で Unit1 新規に3個充填。残1。
    手順3: 残1個を FFD -> Unit1 は 126>100 で不適合 -> Unit2 新規。
    結果: Unit1 に同長3個が隣接、Unit2 に1個。
    """
    s = Settings(kerf=2.0, edge_trim=0.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)
    part = make_part("p30", length=30.0, qty=4)

    units = pack_1d(instances_of(part), stock, s, "grouped")

    assert len(units) == 2
    unit1 = next(u for u in units if u.index == 1)
    unit2 = next(u for u in units if u.index == 2)
    assert len(unit1.placements) == 3  # 同長3個が同じ原材に集まる
    assert len(unit2.placements) == 1  # 容量超過分のみ新規原材へ

    starts1 = sorted(p.start for p in unit1.placements)
    assert starts1 == [0.0, 32.0, 64.0]  # 30, +30+kerf(2)=32, +30+kerf(2)=64
    assert unit2.placements[0].start == 0.0


def test_grouped_remainder_reuses_existing_unit_via_ffd():
    """grouped 手順3: グループの端数1個は FFD により既存原材の端材へ入る。

    kerf=0, edgeTrim=0, U=100。部材長 [60, 40, 40, 40]。
    グループ60 (k=1) -> Unit1=[60@0]（残り40）。
    グループ40 (k=3): 手順2 c=2 -> Unit2 新規に 40@0, 40@40。残1。
    手順3: 残1個を FFD -> Unit1: 60+40=100<=100 適合 -> Unit1 に 40@60。
    （新規原材を開かず既存の端材を使う = 手順3 の存在意義）
    """
    s = Settings(kerf=0.0, edge_trim=0.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)
    p60 = make_part("p60", length=60.0, qty=1)
    p40 = make_part("p40", length=40.0, qty=3)
    instances = instances_of(p60) + instances_of(p40)

    units = pack_1d(instances, stock, s, "grouped")

    assert len(units) == 2
    unit1 = next(u for u in units if u.index == 1)
    unit2 = next(u for u in units if u.index == 2)
    assert {(p.instance.instance_id, p.start) for p in unit1.placements} == {
        ("p60#1", 0.0),
        ("p40#3", 60.0),  # 端数1個が Unit1 の端材へ
    }
    assert {(p.instance.instance_id, p.start) for p in unit2.placements} == {
        ("p40#1", 0.0),
        ("p40#2", 40.0),
    }


def test_grouped_c1_fallback_behaves_like_ffd():
    """grouped 手順2 の c==1 フォールバック: 新品1本に1個しか入らない長い部材は
    グループ充填せず、1個ずつ FFD 挙動になる。

    kerf=0, edgeTrim=0, U=100。部材長 [70, 60, 60]。
    グループ70 (k=1) -> 手順3 FFD -> Unit1=[70@0]。
    グループ60 (k=2): c=1（60<=100 だが 60+60=120>100）-> 手順2 スキップ ->
    手順3 で1個ずつ FFD: どの既存原材にも入らないため Unit2=[60@0], Unit3=[60@0]。
    結果は ffd と完全一致する（設計 §3 改訂版の意図どおり）。
    """
    s = Settings(kerf=0.0, edge_trim=0.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)
    p70 = make_part("p70", length=70.0, qty=1)
    p60 = make_part("p60", length=60.0, qty=2)
    instances = instances_of(p70) + instances_of(p60)

    grouped_units = pack_1d(instances, stock, s, "grouped")
    ffd_units = pack_1d(instances, stock, s, "ffd")

    assert len(grouped_units) == 3
    assert all(len(u.placements) == 1 for u in grouped_units)
    assert flatten_starts(grouped_units) == [
        (1, "p70#1", 0.0),
        (2, "p60#1", 0.0),
        (3, "p60#2", 0.0),
    ]
    # c==1 経路は FFD と同一出力（グループ充填の劣化を避けるためのフォールバック）
    assert flatten_starts(grouped_units) == flatten_starts(ffd_units)


def test_determinism_two_runs_identical():
    """同一入力を2回実行しても完全に一致する（安定・決定的ソートの帰結）。"""
    s = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=None)
    stock = make_stock(length=200.0)
    part_a = make_part("a", length=40.0, qty=3)
    part_b = make_part("b", length=25.0, qty=2)
    part_c = make_part("c", length=40.0, qty=1)  # a と同長、id違い（タイブレーク確認）
    instances = instances_of(part_a) + instances_of(part_b) + instances_of(part_c)

    for method in ("ffd", "bfd", "grouped"):
        result1 = pack_1d(instances, stock, s, method)
        result2 = pack_1d(instances, stock, s, method)
        assert flatten_starts(result1) == flatten_starts(result2)
        assert [u.index for u in result1] == [u.index for u in result2]


def test_sort_tie_break_by_part_id_and_index():
    """同長タイブレーク: (part.id, instance.index) 昇順で決定的に並ぶ（3方式共通）。

    grouped では同長グループ内の処理順序の検証を兼ねる（設計改訂版でも
    グループ内順序は (part.id, instance.index) 昇順と規定されている）。
    """
    s = Settings(kerf=0.0, edge_trim=0.0, candidates=3, selected_plan=None)
    stock = make_stock(length=1000.0)  # 十分大きく、常に1本に収まる
    # 同じ長さ(10)の部材を id 逆順・qty>1 で用意し、処理順が
    # (id昇順, index昇順) になることを配置順（start昇順）から確認する。
    part_b = make_part("b", length=10.0, qty=2)  # b#1, b#2
    part_a = make_part("a", length=10.0, qty=2)  # a#1, a#2
    instances = instances_of(part_b) + instances_of(part_a)

    for method in ("ffd", "bfd", "grouped"):
        units = pack_1d(instances, stock, s, method)
        assert len(units) == 1
        ordered_ids = [
            p.instance.instance_id
            for p in sorted(units[0].placements, key=lambda p: p.start)
        ]
        assert ordered_ids == ["a#1", "a#2", "b#1", "b#2"]


# ---------------------------------------------------------------------------
# §10-5: カット回数（1D 部分、cut_count_1d との結合）
# ---------------------------------------------------------------------------


def test_cut_count_n1_edge_trim_positive():
    """n=1, edgeTrim>0 -> 2回（先頭捨て切り + 末尾切り）。"""
    s = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)
    part = make_part("p", length=50.0, qty=1)

    units = pack_1d(instances_of(part), stock, s, "ffd")
    assert len(units) == 1
    cc = cut_count_1d(units[0].placements, stock, s)
    assert cc == 2


def test_cut_count_n1_edge_trim_zero_full_length():
    """n=1, edgeTrim=0, len==L -> 0回（先頭・末尾とも省略）。"""
    s = Settings(kerf=3.0, edge_trim=0.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)
    part = make_part("p", length=100.0, qty=1)

    units = pack_1d(instances_of(part), stock, s, "ffd")
    assert len(units) == 1
    cc = cut_count_1d(units[0].placements, stock, s)
    assert cc == 0


def test_cut_count_n3_full_case():
    """n=3 のフルケース: edgeTrim>0 なら leading(1) + interior(2) + trailing(1) = 4。"""
    s = Settings(kerf=3.0, edge_trim=5.0, candidates=3, selected_plan=None)
    stock = make_stock(length=100.0)  # U = 90
    part = make_part("p", length=20.0, qty=3)  # 20*3+2*3=66<=90、余裕あり

    units = pack_1d(instances_of(part), stock, s, "ffd")
    assert len(units) == 1
    assert len(units[0].placements) == 3
    cc = cut_count_1d(units[0].placements, stock, s)
    assert cc == 4


def test_cut_count_n3_matches_fits_1d_and_usable_length_helpers():
    """cut_count_1d の前提となる fits_1d / usable_length と pack_1d の整合性を確認する。"""
    s = Settings(kerf=2.0, edge_trim=4.0, candidates=3, selected_plan=None)
    stock = make_stock(length=120.0)
    usable = usable_length(stock.length, s.edge_trim)
    assert usable == 112.0

    part = make_part("p", length=30.0, qty=3)  # 30*3+2*2=94<=112
    units = pack_1d(instances_of(part), stock, s, "bfd")
    assert len(units) == 1

    # pack_1d が生成した配置が fits_1d の容量条件を満たしていることを再確認する
    # （n個目までの累積が usable を超えていない）。
    placements_sorted = sorted(units[0].placements, key=lambda p: p.start)
    used = 0.0
    for i, p in enumerate(placements_sorted):
        assert fits_1d(used, i, p.instance.part.length, s.kerf, usable)
        used = used + (s.kerf if i > 0 else 0.0) + p.instance.part.length

    cc = cut_count_1d(units[0].placements, stock, s)
    assert cc == 4  # leading(1) + interior(2) + trailing(1)
