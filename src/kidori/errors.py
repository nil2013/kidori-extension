"""kidori のエラー型定義。

Issue はスキーマ検証・意味検証で検出された問題1件を表す不変値である。
ProjectError は検証エラー（severity="error"）が1件以上存在する場合に
loader が送出する例外で、検出された Issue 一覧を保持する
（warning のみの場合はこの例外を送出せず、呼び出し側に Issue 一覧を返す）。
KidoriError は kidori 固有の例外の基底クラスであり、ProjectError 以外の
実行時エラー（入出力エラー・CLI 引数エラー等）もここから派生させる。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Issue:
    """検証で検出された1件の問題。

    Attributes:
        path: 問題箇所を指す表記のパス（例: "parts[2].features[0].pos"）。
        message: 日本語のエラー・警告メッセージ。
        severity: "error"（build を停止させる）または "warning"（継続可能）。
    """

    path: str
    message: str
    severity: Literal["error", "warning"]


class KidoriError(Exception):
    """kidori 固有の例外の基底クラス。

    ProjectError（正本データの検証エラー）に限らず、入出力エラーや
    CLI 引数エラーなど kidori 内で発生する例外は本クラスを継承する。
    """


class ProjectError(KidoriError):
    """正本データ（project.yaml / project.json）の検証エラー。

    issues には severity="error" の Issue が少なくとも1件含まれる。
    """

    def __init__(self, issues: list[Issue]) -> None:
        self.issues = issues
        error_count = sum(1 for issue in issues if issue.severity == "error")
        super().__init__(f"project の検証に失敗しました（error {error_count} 件）")
