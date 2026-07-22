"""build.py の単体テスト（設計正本 .claude/logs/2026-07-22-design.md §9・§10-10）。

conftest.py の ``minimal_project`` / ``yaml_writer`` フィクスチャ（Track A 所有）を
そのまま利用する。build() の①〜⑨フロー全体を tmp_path 上で検証する。
CLI 経由の E2E は test_cli.py に委ね、本ファイルは build() 関数の直接呼び出しに絞る。
"""

from __future__ import annotations

import json

import pytest

from kidori.build import BuildResult, build

try:
    import cairosvg  # noqa: F401

    _CAIROSVG_AVAILABLE = True
except Exception:
    _CAIROSVG_AVAILABLE = False


# ---------------------------------------------------------------------------
# ①〜⑧: 期待ファイル一式の存在
# ---------------------------------------------------------------------------


def test_build_creates_expected_file_set(minimal_project, yaml_writer):
    project_path = yaml_writer(minimal_project)
    result = build(project_path)

    assert isinstance(result, BuildResult)
    assert result.plan_ids == ["A", "B", "C"]
    assert result.warnings == []

    out_dir = project_path.parent / "out"
    assert result.out_dir == out_dir

    for plan_id in ("A", "B", "C"):
        assert (out_dir / f"plan-{plan_id}.svg").exists()

    part_ids = {p["id"] for p in minimal_project["parts"]}
    assert part_ids == {"shelf-0", "side-0"}
    for part_id in part_ids:
        assert (out_dir / "parts" / f"{part_id}.svg").exists()

    summary_path = out_dir / "summary.json"
    assert summary_path.exists()
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert summary["selectedPlan"] is None
    assert [p["id"] for p in summary["plans"]] == ["A", "B", "C"]

    schema_path = project_path.parent / "project.schema.json"
    assert schema_path.exists()


def test_build_svg_count_equals_candidates_and_parts_count_equals_part_defs(
    minimal_project, yaml_writer
):
    project_path = yaml_writer(minimal_project)
    result = build(project_path)

    svg_paths = [p for p in result.svg_paths if p.suffix == ".svg"]
    plan_svgs = [p for p in svg_paths if p.name.startswith("plan-")]
    part_svgs = [p for p in svg_paths if p.parent.name == "parts"]

    assert len(plan_svgs) == 3  # settings.candidates == 3
    assert len(part_svgs) == len(minimal_project["parts"])  # 部材"定義"数（qty 展開しない）


def test_build_prints_modeline_notice_when_missing(minimal_project, yaml_writer, capsys):
    # yaml_writer は YAML(typ="safe") で素の dict を書き出すため、
    # モードラインは含まれない。案内が1回出ることを確認する。
    project_path = yaml_writer(minimal_project)
    build(project_path)
    captured = capsys.readouterr()
    assert "yaml-language-server" in captured.err


# ---------------------------------------------------------------------------
# PNG（cairosvg の有無に応じて分岐）
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not _CAIROSVG_AVAILABLE, reason="cairosvg がローカルで利用できないため PNG 生成テストをスキップ"
)
def test_build_generates_png_when_cairosvg_available(minimal_project, yaml_writer):
    project_path = yaml_writer(minimal_project)
    result = build(project_path)

    assert len(result.png_paths) == len(result.svg_paths)
    for png_path in result.png_paths:
        assert png_path.exists()
        assert png_path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


@pytest.mark.skipif(
    _CAIROSVG_AVAILABLE, reason="cairosvg が利用可能な環境のため、利用不可時のスキップ挙動テストは対象外"
)
def test_build_skips_png_when_cairosvg_unavailable(minimal_project, yaml_writer, capsys):
    project_path = yaml_writer(minimal_project)
    result = build(project_path)

    assert result.png_paths == []
    captured = capsys.readouterr()
    assert "cairosvg" in captured.err


def test_build_no_png_flag_skips_png_generation_entirely(minimal_project, yaml_writer):
    project_path = yaml_writer(minimal_project)
    result = build(project_path, png=False)

    assert result.png_paths == []
    out_dir = project_path.parent / "out"
    assert not any(out_dir.glob("*.png"))
    assert not any((out_dir / "parts").glob("*.png"))


# ---------------------------------------------------------------------------
# ⑨ 陳腐化ファイル削除（selectedPlan 切替）
# ---------------------------------------------------------------------------


def test_build_selected_plan_removes_other_plan_files_but_keeps_unmanaged(
    minimal_project, yaml_writer
):
    project_path = yaml_writer(minimal_project)
    build(project_path)  # 全案 A/B/C を生成

    out_dir = project_path.parent / "out"
    assert (out_dir / "plan-A.svg").exists()
    assert (out_dir / "plan-B.svg").exists()
    assert (out_dir / "plan-C.svg").exists()

    # 管理対象パターンに一致しない「管理外ファイル」を混ぜておく。
    unmanaged_out = out_dir / "notes.txt"
    unmanaged_out.write_text("管理対象外のメモ", encoding="utf-8")
    unmanaged_part = out_dir / "parts" / "notes.txt"
    unmanaged_part.write_text("管理対象外のメモ2", encoding="utf-8")

    minimal_project["settings"]["selectedPlan"] = "B"
    yaml_writer(minimal_project)  # 同じ project.yaml を上書き

    result = build(project_path)

    assert result.plan_ids == ["B"]
    assert not (out_dir / "plan-A.svg").exists()
    assert not (out_dir / "plan-C.svg").exists()
    assert (out_dir / "plan-B.svg").exists()

    # 加工指示図はどちらの場合も常に全部材分残る。
    assert (out_dir / "parts" / "shelf-0.svg").exists()
    assert (out_dir / "parts" / "side-0.svg").exists()

    # 管理外ファイルには一切触れない。
    assert unmanaged_out.exists()
    assert unmanaged_part.exists()

    # selectedPlan 設定時は加工指示図ヘッダに配置番号が入る（設計正本 §6・§9）。
    partcard_text = (out_dir / "parts" / "shelf-0.svg").read_text(encoding="utf-8")
    assert "配置: 案B" in partcard_text


def test_build_null_selected_plan_partcard_has_no_placement_header(minimal_project, yaml_writer):
    project_path = yaml_writer(minimal_project)
    build(project_path)
    out_dir = project_path.parent / "out"
    partcard_text = (out_dir / "parts" / "shelf-0.svg").read_text(encoding="utf-8")
    assert "配置" not in partcard_text
