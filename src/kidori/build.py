"""ビルドオーケストレータ（設計正本 .claude/logs/2026-07-22-design.md §9 準拠）。

`build(project_path, out_dir=None, png=True, png_scale=2.0) -> BuildResult` が
公開エントリ。設計正本 §9 の build フロー ①〜⑨ を実装する:

    ① read_raw（失敗しても schema 書き出しは試みる）
    ② write_schema（stocks 抽出可能なら enum 入り）
    ③ load_project（error なら Issue 一覧を日本語表示し ProjectError を伝播）
    ④ generate_plans
    ⑤ metrics（summarize / build_summary）
    ⑥ plan-X.svg + parts/*.svg
    ⑦ PNG（png.py 経由。cairosvg 利用不可なら警告してスキップ）
    ⑧ summary.json（generatedAt は build 時刻の ISO 文字列）
    ⑨ 管理対象パターン（plan-*.svg/png, parts/*.svg/png, summary.json）の
       陳腐化ファイル削除（管理外ファイルには触れない）

既存契約（変更禁止）: loader.py（load_project / read_raw のみを公開契約として
利用する。loader.py 内部の private ヘルパは import しない）。schema.py
（write_schema）。packing/__init__.py（generate_plans）。metrics.py
（summarize / build_summary）。render/cutplan.py（render_cutplan）。
render/partcard.py（render_partcard）。
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from kidori.errors import Issue, ProjectError
from kidori.loader import load_project, read_raw
from kidori.metrics import build_summary, summarize
from kidori.packing import generate_plans
from kidori.png import svg_to_png
from kidori.render.cutplan import render_cutplan
from kidori.render.partcard import render_partcard
from kidori.schema import write_schema

#: モードライン（YAML 先頭行）の想定プレフィックス（設計正本 §7）。
_MODELINE_PREFIX = "# yaml-language-server: $schema="


@dataclass(frozen=True)
class BuildResult:
    """build() の実行結果。CLI・watch・テストからの検証に使う。

    Attributes:
        project_path: 読み込んだ project ファイルのパス。
        out_dir: 出力先ディレクトリ（plan-*.svg/png・summary.json の置き場）。
        parts_dir: 加工指示図の出力先ディレクトリ（out_dir/parts）。
        plan_ids: 今回生成した割付案の ID 一覧（selectedPlan 設定時は1件のみ）。
        svg_paths: 生成した SVG（木取り図＋加工指示図）のパス一覧。
        png_paths: 生成した PNG のパス一覧（cairosvg 利用不可の場合は空）。
        summary_path: summary.json のパス。
        warnings: load_project が返した警告 Issue 一覧（error は ProjectError で
            送出されるためここには含まれない）。
        png_enabled: 呼び出し時の png 引数（cairosvg が実際に使えたかどうかは
            png_paths の有無で判断する。png=True でも環境に cairosvg が無ければ
            png_paths は空になる）。
    """

    project_path: Path
    out_dir: Path
    parts_dir: Path
    plan_ids: list[str]
    svg_paths: list[Path]
    png_paths: list[Path]
    summary_path: Path
    warnings: list[Issue]
    png_enabled: bool


def _print_issue(issue: Issue) -> None:
    """Issue 1件を日本語で stderr に出力する。"""

    label = "エラー" if issue.severity == "error" else "警告"
    print(f"[{label}] {issue.path}: {issue.message}", file=sys.stderr)


def _extract_stock_ids_best_effort(raw: object) -> list[str]:
    """raw から stocks[].id の一覧を可能な範囲で抽出する（schema enum 注入用）。

    loader.py にも同種のロジック（_extract_stock_ids）が存在するが、
    build.py は loader.py の公開契約（load_project / read_raw）のみに依存する
    方針のため、private ヘルパを import せず独立して実装する。
    """

    if not isinstance(raw, dict):
        return []
    stocks = raw.get("stocks")
    if not isinstance(stocks, list):
        return []
    ids: list[str] = []
    for s in stocks:
        if isinstance(s, dict) and isinstance(s.get("id"), str):
            ids.append(s["id"])
    return ids


def _check_modeline(project_path: Path) -> None:
    """project.yaml 先頭にモードラインが無ければ stderr に案内を1回出す（設計正本 §7）。

    kidori はユーザーの YAML を書き換えない。JSON 入力にはモードラインの概念が
    無いため対象外。ファイルが読めない場合は静かに何もしない
    （読込エラー自体は後続の read_raw/load_project が報告する）。
    """

    if project_path.suffix == ".json":
        return
    try:
        with project_path.open("r", encoding="utf-8") as f:
            first_line = f.readline()
    except OSError:
        return
    if not first_line.strip().startswith(_MODELINE_PREFIX):
        print(
            "[案内] project.yaml の先頭行に "
            f"`{_MODELINE_PREFIX}./project.schema.json` を追記すると、"
            "エディタでの補完・検証が有効になります。",
            file=sys.stderr,
        )


def _cleanup_stale(
    out_dir: Path, parts_dir: Path, managed_svg: set[str], managed_png: set[str]
) -> None:
    """管理対象パターンのうち今回生成しなかったファイルを削除する（設計正本 §9 ⑨）。

    管理対象パターン: ``plan-*.svg`` / ``plan-*.png``（out_dir 直下）、
    ``parts/*.svg`` / ``parts/*.png``、``summary.json``。summary.json は
    build() が毎回必ず上書きするため削除対象から除外する（陳腐化しない）。
    管理対象パターンに一致しないファイル（管理外ファイル）には一切触れない。

    Args:
        out_dir: 出力先ディレクトリ。
        parts_dir: 加工指示図の出力先ディレクトリ。
        managed_svg: 今回生成した SVG の識別子集合
            （out_dir 直下は ``"plan-A.svg"``、parts 配下は ``"parts/side-0.svg"`` 形式）。
        managed_png: 今回生成した PNG の識別子集合（管理形式は managed_svg と同様）。
    """

    if out_dir.exists():
        for f in out_dir.glob("plan-*.svg"):
            if f.name not in managed_svg:
                f.unlink()
        for f in out_dir.glob("plan-*.png"):
            if f.name not in managed_png:
                f.unlink()
    if parts_dir.exists():
        for f in parts_dir.glob("*.svg"):
            if f"parts/{f.name}" not in managed_svg:
                f.unlink()
        for f in parts_dir.glob("*.png"):
            if f"parts/{f.name}" not in managed_png:
                f.unlink()


def build(
    project_path: Path,
    out_dir: Path | None = None,
    png: bool = True,
    png_scale: float = 2.0,
) -> BuildResult:
    """project.yaml / project.json から SVG・PNG・summary.json を生成する。

    設計正本 §9 の build フロー ①〜⑨ をこの順で実行する（モジュール docstring 参照）。

    Args:
        project_path: project.yaml（または project.json）のパス。
        out_dir: 出力先ディレクトリ。None の場合 ``project_path.parent / "out"``。
        png: PNG も生成するか。False なら PNG 生成をスキップする
            （cairosvg が利用できない場合も自動的にスキップされ、build は成功扱いになる）。
        png_scale: PNG 変換時のスケール（cairosvg の scale 引数にそのまま渡す）。

    Returns:
        BuildResult（生成物のパス一覧・警告一覧を含む）。

    Raises:
        ProjectError: 正本データの検証エラー（severity="error"）が1件以上ある場合。
            送出前に検出された Issue 一覧を stderr に日本語で出力する。
        OSError: ファイル入出力に失敗した場合。
        Exception: YAML/JSON の構文エラー等、read_raw/load_project がそのまま
            送出する例外（呼び出し側の cli.py が捕捉してメッセージ表示・
            終了コード決定を行う想定）。
    """

    project_path = Path(project_path)
    out_dir = Path(out_dir) if out_dir is not None else project_path.parent / "out"
    parts_dir = out_dir / "parts"

    _check_modeline(project_path)

    # ① raw 読込（失敗しても schema 書き出しは試みる。stocks すら読めない場合は
    #    enum なしスキーマになる）。
    try:
        raw_for_schema = read_raw(project_path)
    except Exception:
        raw_for_schema = None
    stock_ids = _extract_stock_ids_best_effort(raw_for_schema)

    # ② schema 書き出し（検証より先に、毎回）。
    write_schema(project_path, stock_ids)

    # ③ 検証。error があれば Issue 一覧を表示して ProjectError を伝播する。
    try:
        project, warning_issues = load_project(project_path)
    except ProjectError as e:
        for issue in e.issues:
            _print_issue(issue)
        raise
    for issue in warning_issues:
        _print_issue(issue)

    # ④ 割付案生成。
    plans = generate_plans(project)

    # ⑤ メトリクス。
    generated_at = datetime.now().astimezone().isoformat(timespec="seconds")
    plan_summaries = [summarize(plan, project) for plan in plans]
    summary = build_summary(plan_summaries, project, generated_at)

    out_dir.mkdir(parents=True, exist_ok=True)
    parts_dir.mkdir(parents=True, exist_ok=True)

    managed_svg: set[str] = set()
    managed_png: set[str] = set()
    svg_paths: list[Path] = []
    png_paths: list[Path] = []

    # ⑥ 木取り図 SVG（+ ⑦ PNG）。
    for plan, plan_summary in zip(plans, plan_summaries):
        svg_text = render_cutplan(plan, project, plan_summary)
        svg_name = f"plan-{plan.id}.svg"
        svg_path = out_dir / svg_name
        svg_path.write_text(svg_text, encoding="utf-8")
        managed_svg.add(svg_name)
        svg_paths.append(svg_path)

        if png:
            png_name = f"plan-{plan.id}.png"
            png_path = out_dir / png_name
            if svg_to_png(svg_text, png_path, png_scale):
                managed_png.add(png_name)
                png_paths.append(png_path)

    # 加工指示図: selectedPlan 設定時のみヘッダに配置番号（Plan.seq）を渡す。
    # null 時は seq_labels=None（設計正本 §6・§9: 案ごとに番号が異なるため）。
    selected_plan_id = project.settings.selected_plan
    seq_by_part: dict[str, list[int]] = {}
    if selected_plan_id is not None:
        selected = next((p for p in plans if p.id == selected_plan_id), None)
        if selected is not None:
            for instance_id, seq_num in selected.seq.items():
                part_id = instance_id.rsplit("#", 1)[0]
                seq_by_part.setdefault(part_id, []).append(seq_num)
            for nums in seq_by_part.values():
                nums.sort()

    stocks_by_id = {s.id: s for s in project.stocks}
    for part in project.parts:
        stock = stocks_by_id.get(part.stock)
        if stock is None:
            # 意味検証層で既に error になっているはずだが、防御的にスキップする。
            continue
        seq_labels = seq_by_part.get(part.id) if selected_plan_id is not None else None
        svg_text = render_partcard(part, stock, seq_labels=seq_labels, plan_id=selected_plan_id)
        svg_name = f"{part.id}.svg"
        svg_path = parts_dir / svg_name
        svg_path.write_text(svg_text, encoding="utf-8")
        managed_svg.add(f"parts/{svg_name}")
        svg_paths.append(svg_path)

        if png:
            png_name = f"{part.id}.png"
            png_path = parts_dir / png_name
            if svg_to_png(svg_text, png_path, png_scale):
                managed_png.add(f"parts/{png_name}")
                png_paths.append(png_path)

    # ⑧ summary.json。
    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # ⑨ 陳腐化ファイル削除（selectedPlan 切替等で今回生成しなかった管理対象ファイルを除去）。
    _cleanup_stale(out_dir, parts_dir, managed_svg, managed_png)

    return BuildResult(
        project_path=project_path,
        out_dir=out_dir,
        parts_dir=parts_dir,
        plan_ids=[p.id for p in plans],
        svg_paths=svg_paths,
        png_paths=png_paths,
        summary_path=summary_path,
        warnings=warning_issues,
        png_enabled=png,
    )
