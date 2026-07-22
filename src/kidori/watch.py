"""project.yaml の変更監視（設計正本 .claude/logs/2026-07-22-design.md §9 準拠）。

追加依存なし（watchfiles 等は使わない）。``(mtime_ns, size)`` のポーリングで
変化を検知し、200ms のデバウンスを経てから再ビルドのコールバックを呼び出す。

テスト容易性のため、以下の2層に分離する:
    - :class:`DebouncedWatcher`: 「変化検知 → デバウンス → コールバック呼び出し」の
      純粋な状態遷移ロジック。``time.sleep`` を含まないため単体テスト可能。
    - :func:`watch`: ``while True: sleep(...)`` のポーリングループ本体。
      E2E テスト対象外（ループ自体は設計正本 §10-10 で明示的にテスト対象外可）。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Callable

from kidori.build import build
from kidori.errors import KidoriError

#: デフォルトのポーリング間隔（秒。設計正本 §9）。
DEFAULT_INTERVAL = 0.5

#: 変化検知後のデバウンス時間（秒。設計正本 §9）。
DEBOUNCE_SECONDS = 0.2

Fingerprint = tuple[int, int] | None


def file_fingerprint(path: Path) -> Fingerprint:
    """project ファイルの ``(mtime_ns, size)`` を返す。存在しない・stat 失敗時は None。"""

    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


class DebouncedWatcher:
    """「変化検知 → 200ms デバウンス → コールバック呼び出し」の状態機械。

    ポーリングのたびに :meth:`poll` を呼び出す想定。fingerprint が前回の値と
    異なれば「変化待ち」状態に入り、以後 fingerprint が変化しないまま
    ``debounce_seconds`` が経過した時点でコールバックを実行し状態をリセットする。
    デバウンス待ち中にさらに fingerprint が変化した場合は、待ち時刻を最新の
    変化時刻に更新する（エディタの複数回書き込み・アトミック保存の中間状態を
    1回の build にまとめる）。

    ``time.sleep`` 等の実時間待機を含まないため、`now` に任意の float を
    渡すだけで単体テストできる。
    """

    def __init__(self, callback: Callable[[], None], debounce_seconds: float = DEBOUNCE_SECONDS) -> None:
        self._callback = callback
        self._debounce_seconds = debounce_seconds
        self._last_fingerprint: Fingerprint = None
        self._pending_since: float | None = None
        self._initialized = False

    def prime(self, fingerprint: Fingerprint) -> None:
        """初期状態（起動直後の基準値）を設定する。以後の最初の poll はこの値と比較する。"""

        self._last_fingerprint = fingerprint
        self._pending_since = None
        self._initialized = True

    def poll(self, fingerprint: Fingerprint, now: float) -> bool:
        """1回分のポーリング結果を反映する。

        Args:
            fingerprint: 現在の ``(mtime_ns, size)``（:func:`file_fingerprint` の戻り値）。
            now: 現在時刻（``time.monotonic()`` 相当の単調増加値）。

        Returns:
            この呼び出しでコールバックを実行したら True、それ以外は False。
        """

        if not self._initialized:
            self.prime(fingerprint)
            return False

        if fingerprint != self._last_fingerprint:
            self._last_fingerprint = fingerprint
            self._pending_since = now
            return False

        if self._pending_since is not None and (now - self._pending_since) >= self._debounce_seconds:
            self._pending_since = None
            self._callback()
            return True

        return False


def watch(
    project_path: Path,
    *,
    out_dir: Path | None = None,
    png: bool = True,
    png_scale: float = 2.0,
    interval: float = DEFAULT_INTERVAL,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """project.yaml の変更を監視し、変化を検知するたびに build する（設計正本 §9）。

    起動時に1回 build を実行し、以後 ``interval`` 秒間隔で project_path の
    ``(mtime_ns, size)`` をポーリングする。変化検知後は :data:`DEBOUNCE_SECONDS`
    のデバウンスを経て再 build する。検証エラー（ProjectError 等）が起きても
    watch 自体は継続する（stderr にエラーメッセージを出すのみ）。

    Args:
        project_path: 監視対象の project.yaml / project.json。
        out_dir, png, png_scale: そのまま ``build()`` に渡す。
        interval: ポーリング間隔（秒）。
        sleep: ポーリングのスリープ関数（テスト用の差し替え口。既定は time.sleep）。
        clock: 現在時刻取得関数（テスト用の差し替え口。既定は time.monotonic）。

    Raises:
        KeyboardInterrupt: Ctrl-C で監視を終了する場合にそのまま呼び出し側へ
            伝播する（cli.py が捕捉して終了メッセージを表示する想定）。
    """

    def _run_build() -> None:
        try:
            build(project_path, out_dir=out_dir, png=png, png_scale=png_scale)
        except KidoriError as e:
            print(f"[watch] build に失敗しました: {e}", file=sys.stderr)
        except Exception as e:  # 想定外のエラーでも watch は継続する（設計正本 §9）
            print(f"[watch] build 中に予期しないエラーが発生しました: {e}", file=sys.stderr)
        else:
            print(f"[watch] build 完了: {project_path}", file=sys.stderr)

    _run_build()

    watcher = DebouncedWatcher(_run_build, debounce_seconds=DEBOUNCE_SECONDS)
    watcher.prime(file_fingerprint(project_path))

    while True:
        sleep(interval)
        watcher.poll(file_fingerprint(project_path), clock())
