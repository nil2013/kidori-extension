"""watch.py の単体テスト（設計正本 .claude/logs/2026-07-22-design.md §9・§10-10）。

ポーリングループ本体（``time.sleep`` を伴う ``while True``）は E2E テスト対象外
（設計正本 §10-10: 「watch はデバウンスロジックを関数単位でテスト（ループ自体は
E2E 対象外で可）」）。本ファイルは「変化検知 → 200ms デバウンス → コールバック
呼び出し」の状態遷移ロジック（:class:`DebouncedWatcher`）と ``file_fingerprint``
のみを、仮想時刻・仮想フィンガープリントを与えて検証する。
"""

from __future__ import annotations

from kidori.watch import DebouncedWatcher, file_fingerprint


def test_debounced_watcher_fires_after_debounce_window():
    calls: list[int] = []
    watcher = DebouncedWatcher(lambda: calls.append(1), debounce_seconds=0.2)
    watcher.prime("fp0")

    # 変化を検知（t=0）。まだデバウンス中なので呼ばれない。
    assert watcher.poll("fp1", now=0.0) is False
    assert calls == []

    # 変化から0.1秒後、fingerprint は変わらず。デバウンス未達なのでまだ呼ばれない。
    assert watcher.poll("fp1", now=0.1) is False
    assert calls == []

    # 変化から0.2秒後（デバウンス時間ちょうど）。呼ばれる。
    assert watcher.poll("fp1", now=0.2) is True
    assert calls == [1]

    # 直後にもう一度ポーリングしても、変化がなければ再度は呼ばれない。
    assert watcher.poll("fp1", now=0.3) is False
    assert calls == [1]


def test_debounced_watcher_does_not_fire_without_any_change():
    calls: list[int] = []
    watcher = DebouncedWatcher(lambda: calls.append(1))
    watcher.prime("fp0")

    assert watcher.poll("fp0", now=100.0) is False
    assert calls == []


def test_debounced_watcher_resets_debounce_window_on_further_change():
    """デバウンス待ち中にさらに変化した場合、待ち時刻が最新の変化時刻に更新される。"""

    calls: list[int] = []
    watcher = DebouncedWatcher(lambda: calls.append(1), debounce_seconds=0.2)
    watcher.prime("fp0")

    assert watcher.poll("fp1", now=0.0) is False
    # デバウンス完了直前（0.15）にさらに変化（エディタの複数回書き込みを想定）。
    assert watcher.poll("fp2", now=0.15) is False
    # 最初の変化（t=0）から0.2秒経過していても、直近の変化（t=0.15）からは
    # まだ0.2秒経っていないため、まだ呼ばれない。
    assert watcher.poll("fp2", now=0.2) is False
    assert calls == []
    # 直近の変化（t=0.15）から0.2秒超経過（浮動小数の丸め誤差を避けるため
    # ちょうど0.35ではなく余裕を持たせる。0.35 - 0.15 は浮動小数演算では
    # 0.19999999999999998 になり得るため、境界値ちょうどでの比較は避ける）。
    assert watcher.poll("fp2", now=0.36) is True
    assert calls == [1]


def test_debounced_watcher_fires_again_for_subsequent_change():
    calls: list[int] = []
    watcher = DebouncedWatcher(lambda: calls.append(1), debounce_seconds=0.2)
    watcher.prime("fp0")

    watcher.poll("fp1", now=0.0)
    assert watcher.poll("fp1", now=0.2) is True
    assert calls == [1]

    # 続けて別の変化。再度デバウンスを経て呼ばれる。
    assert watcher.poll("fp2", now=0.2) is False
    assert watcher.poll("fp2", now=0.4) is True
    assert calls == [1, 1]


def test_debounced_watcher_first_poll_after_prime_with_same_fingerprint_is_noop():
    calls: list[int] = []
    watcher = DebouncedWatcher(lambda: calls.append(1))
    fp = (123, 456)
    watcher.prime(fp)

    assert watcher.poll(fp, now=0.0) is False
    assert calls == []


def test_file_fingerprint_returns_none_for_missing_file(tmp_path):
    missing = tmp_path / "does-not-exist.yaml"
    assert file_fingerprint(missing) is None


def test_file_fingerprint_changes_on_size_change(tmp_path):
    path = tmp_path / "project.yaml"
    path.write_text("a", encoding="utf-8")
    fp1 = file_fingerprint(path)

    # サイズが変われば（mtime の解像度に関わらず）フィンガープリントも変わる。
    path.write_text("ab", encoding="utf-8")
    fp2 = file_fingerprint(path)

    assert fp1 is not None and fp2 is not None
    assert fp1 != fp2


def test_file_fingerprint_stable_when_unchanged(tmp_path):
    path = tmp_path / "project.yaml"
    path.write_text("stable", encoding="utf-8")

    assert file_fingerprint(path) == file_fingerprint(path)
