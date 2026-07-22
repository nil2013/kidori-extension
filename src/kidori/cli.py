"""kidori CLI（argparse、設計正本 .claude/logs/2026-07-22-design.md §9 準拠）。

サブコマンド:
    kidori build  [PROJECT] [--out DIR] [--no-png] [--png-scale FLOAT]
    kidori watch  [PROJECT] [--out DIR] [--no-png] [--png-scale FLOAT] [--interval FLOAT]
    kidori select PLAN_ID [PROJECT] [--out DIR] [--no-png] [--png-scale FLOAT]

終了コード: 0 成功 / 1 検証エラー（ProjectError） / 2 入出力・引数エラー。
メッセージはすべて日本語。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap

from kidori.build import build
from kidori.errors import ProjectError
from kidori.watch import watch as _watch

#: PROJECT 引数省略時のデフォルト（設計正本 §9）。
DEFAULT_PROJECT = "project.yaml"

#: kidori select PLAN_ID の許容値（"none" は選択解除）。
_SELECT_CHOICES = ("A", "B", "C", "none")


# ---------------------------------------------------------------------------
# 引数パーサ
# ---------------------------------------------------------------------------


def _add_common_build_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "project",
        nargs="?",
        default=DEFAULT_PROJECT,
        help=f"project.yaml のパス（デフォルト: ./{DEFAULT_PROJECT}）",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=None,
        help="出力ディレクトリ（デフォルト: project と同階層の out/）",
    )
    parser.add_argument("--no-png", action="store_true", help="PNG を生成しない")
    parser.add_argument(
        "--png-scale",
        type=float,
        default=2.0,
        help="PNG 変換時のスケール（デフォルト: 2.0）",
    )


def build_arg_parser() -> argparse.ArgumentParser:
    """kidori の argparse パーサを組み立てて返す（テストからも呼べるよう公開する）。"""

    parser = argparse.ArgumentParser(prog="kidori", description="規格材の木取り図・加工指示図ジェネレータ")
    sub = parser.add_subparsers(dest="command", required=True)

    p_build = sub.add_parser("build", help="project.yaml から SVG/PNG/summary.json を生成する")
    _add_common_build_args(p_build)
    p_build.set_defaults(func=_run_build)

    p_watch = sub.add_parser("watch", help="project.yaml の変更を監視し、保存のたびに build する")
    _add_common_build_args(p_watch)
    p_watch.add_argument(
        "--interval",
        type=float,
        default=0.5,
        help="ポーリング間隔（秒、デフォルト: 0.5）",
    )
    p_watch.set_defaults(func=_run_watch)

    p_select = sub.add_parser("select", help="settings.selectedPlan を書き換えてから build する")
    p_select.add_argument(
        "plan_id",
        metavar="PLAN_ID",
        choices=_SELECT_CHOICES,
        help="採用する案 ID（A / B / C）。none を指定すると選択を解除する。",
    )
    p_select.add_argument(
        "project",
        nargs="?",
        default=DEFAULT_PROJECT,
        help=f"project.yaml のパス（デフォルト: ./{DEFAULT_PROJECT}）",
    )
    p_select.add_argument("--out", type=str, default=None, help="出力ディレクトリ（デフォルト: project と同階層の out/）")
    p_select.add_argument("--no-png", action="store_true", help="PNG を生成しない")
    p_select.add_argument("--png-scale", type=float, default=2.0, help="PNG 変換時のスケール（デフォルト: 2.0）")
    p_select.set_defaults(func=_run_select)

    return parser


# ---------------------------------------------------------------------------
# サブコマンド実装
# ---------------------------------------------------------------------------


def _run_build(args: argparse.Namespace) -> int:
    project_path = Path(args.project)
    out_dir = Path(args.out) if args.out else None
    try:
        result = build(project_path, out_dir=out_dir, png=not args.no_png, png_scale=args.png_scale)
    except ProjectError:
        print(
            "project の検証エラーにより build を中止しました。上記のメッセージを修正して再実行してください。",
            file=sys.stderr,
        )
        return 1
    except Exception as e:
        # OSError（入出力エラー）・YAML/JSON 構文エラー等はすべてここに集約する。
        print(f"build に失敗しました: {e}", file=sys.stderr)
        return 2

    print(f"build 完了: {result.out_dir}（案: {', '.join(result.plan_ids) or 'なし'}）")
    return 0


def _run_watch(args: argparse.Namespace) -> int:
    project_path = Path(args.project)
    out_dir = Path(args.out) if args.out else None
    try:
        _watch(
            project_path,
            out_dir=out_dir,
            png=not args.no_png,
            png_scale=args.png_scale,
            interval=args.interval,
        )
    except KeyboardInterrupt:
        print("watch を終了します。", file=sys.stderr)
    return 0


def _write_selected_plan(project_path: Path, selected_value: str | None) -> None:
    """settings.selectedPlan だけを書き換えて project ファイルへ書き戻す。

    YAML の場合は ruamel.yaml のラウンドトリップモード（typ="rt"）を用い、
    コメント・アンカー・キー順を保持したまま該当キーのみ更新する
    （設計正本 §9: 正本保全が最重要の操作）。JSON にはコメントが無いため、
    標準 json モジュールでキー順を保ったまま書き戻す。

    Args:
        project_path: project.yaml / project.json のパス。
        selected_value: 書き込む selectedPlan の値（"A"/"B"/"C"、解除は None）。

    Raises:
        ValueError: トップレベルがオブジェクトでない場合。
        OSError: ファイル入出力に失敗した場合。
        Exception: YAML/JSON の構文エラー（ruamel.yaml / json の例外がそのまま伝播する）。
    """

    if project_path.suffix == ".json":
        with project_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("project ファイルのトップレベルはオブジェクト（マップ）でなければなりません。")
        settings = data.get("settings")
        if not isinstance(settings, dict):
            settings = {}
            data["settings"] = settings
        settings["selectedPlan"] = selected_value
        with project_path.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        return

    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    # ブロックスタイルの配列（parts: の各要素等）のインデントを一般的な
    # 可読フォーマット（ダッシュをマッピングキーから2段、要素本体をさらに
    # 2段インデント）に固定する。指定しないと ruamel のデフォルト
    # （sequence=2, offset=0）でダッシュがキー直下・無インデントになり、
    # 既存のコメントのインデントと視覚的に食い違ってしまう。
    yaml.indent(mapping=2, sequence=4, offset=2)
    # 既定の折り返し幅（80）だと1行フロースタイル（`{ id: ..., ... }`）が
    # 複数行に分割されてしまい、無関係な差分（selectedPlan 以外の変更）が
    # 生じる。十分大きい値にして折り返しを事実上無効化する。
    yaml.width = 100000
    with project_path.open("r", encoding="utf-8") as f:
        data = yaml.load(f)
    if data is None:
        data = CommentedMap()
    settings = data.get("settings")
    if not isinstance(settings, dict):
        settings = CommentedMap()
        data["settings"] = settings
    settings["selectedPlan"] = selected_value
    with project_path.open("w", encoding="utf-8") as f:
        yaml.dump(data, f)


def _run_select(args: argparse.Namespace) -> int:
    selected_value = None if args.plan_id == "none" else args.plan_id
    project_path = Path(args.project)

    try:
        _write_selected_plan(project_path, selected_value)
    except Exception as e:
        print(f"selectedPlan の書き換えに失敗しました: {e}", file=sys.stderr)
        return 2

    return _run_build(args)


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """kidori CLI のエントリポイント。argparse の使用エラーは exit code 2 で終了する。"""

    parser = build_arg_parser()
    args = parser.parse_args(argv)
    return args.func(args)
