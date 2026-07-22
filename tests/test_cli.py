"""cli.py の E2E テスト（設計正本 .claude/logs/2026-07-22-design.md §9・§10-10）。

conftest.py の ``minimal_project`` / ``yaml_writer`` フィクスチャ（Track A 所有）を
利用しつつ、``kidori select`` の正本保全（コメント・アンカー保持）は本ファイル内で
専用の YAML 文字列を組み立てて厳密に検証する（最重要テスト、設計正本 §10-10）。
"""

from __future__ import annotations

import json

import pytest
from ruamel.yaml import YAML

from kidori.cli import main

try:
    import cairosvg  # noqa: F401

    _CAIROSVG_AVAILABLE = True
except Exception:
    _CAIROSVG_AVAILABLE = False


# ---------------------------------------------------------------------------
# kidori build: tmp_path での期待ファイル一式の存在
# ---------------------------------------------------------------------------


def test_cli_build_creates_expected_file_set(minimal_project, yaml_writer):
    project_path = yaml_writer(minimal_project)

    exit_code = main(["build", str(project_path)])

    assert exit_code == 0
    out_dir = project_path.parent / "out"
    for plan_id in ("A", "B", "C"):
        assert (out_dir / f"plan-{plan_id}.svg").exists()
    for part in minimal_project["parts"]:
        assert (out_dir / "parts" / f"{part['id']}.svg").exists()
    assert (out_dir / "summary.json").exists()


def test_cli_build_default_project_path(tmp_path, minimal_project, monkeypatch):
    """PROJECT 省略時は ./project.yaml を使う（設計正本 §9）。"""

    project_path = tmp_path / "project.yaml"
    yaml = YAML(typ="safe")
    with project_path.open("w", encoding="utf-8") as f:
        yaml.dump(minimal_project, f)

    monkeypatch.chdir(tmp_path)
    exit_code = main(["build"])

    assert exit_code == 0
    assert (tmp_path / "out" / "plan-A.svg").exists()


def test_cli_build_no_png_flag(minimal_project, yaml_writer):
    project_path = yaml_writer(minimal_project)
    exit_code = main(["build", str(project_path), "--no-png"])
    assert exit_code == 0
    out_dir = project_path.parent / "out"
    assert not any(out_dir.glob("*.png"))


@pytest.mark.skipif(not _CAIROSVG_AVAILABLE, reason="cairosvg がローカルで利用できないため PNG テストをスキップ")
def test_cli_build_generates_png_by_default(minimal_project, yaml_writer):
    project_path = yaml_writer(minimal_project)
    exit_code = main(["build", str(project_path)])
    assert exit_code == 0
    out_dir = project_path.parent / "out"
    png_files = list(out_dir.glob("plan-*.png"))
    assert len(png_files) == 3
    for f in png_files:
        assert f.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


# ---------------------------------------------------------------------------
# 終了コード
# ---------------------------------------------------------------------------


def test_cli_build_returns_exit_code_1_on_validation_error(minimal_project, yaml_writer, capsys):
    # shelf-0 の長さを原材の使用可能長を超える値にして意味検証エラーを起こす。
    minimal_project["parts"][0]["length"] = 1_000_000
    project_path = yaml_writer(minimal_project)

    exit_code = main(["build", str(project_path)])

    assert exit_code == 1
    captured = capsys.readouterr()
    assert "エラー" in captured.err


def test_cli_build_returns_exit_code_2_on_missing_project_file(tmp_path):
    missing = tmp_path / "does-not-exist.yaml"
    exit_code = main(["build", str(missing)])
    assert exit_code == 2


def test_cli_select_invalid_plan_id_returns_exit_code_2(minimal_project, yaml_writer):
    project_path = yaml_writer(minimal_project)
    with pytest.raises(SystemExit) as exc_info:
        main(["select", "Z", str(project_path)])
    assert exc_info.value.code == 2


def test_cli_missing_command_returns_exit_code_2():
    with pytest.raises(SystemExit) as exc_info:
        main([])
    assert exc_info.value.code == 2


def test_cli_invalid_png_scale_returns_exit_code_2(minimal_project, yaml_writer):
    project_path = yaml_writer(minimal_project)
    with pytest.raises(SystemExit) as exc_info:
        main(["build", str(project_path), "--png-scale", "not-a-float"])
    assert exc_info.value.code == 2


# ---------------------------------------------------------------------------
# kidori select: 正本保全（コメント・アンカー保持、最重要テスト）
# ---------------------------------------------------------------------------

_COMMENTED_PROJECT_YAML = """\
# yaml-language-server: $schema=./project.schema.json
# コメント保持テスト: このコメントは selectedPlan 書き換え後も残っていなければならない。
meta: { project: コメントテスト, units: mm, schemaVersion: "0.2" }

settings:
  kerf: 3            # 刃厚コメント（保持されるべき）
  edgeTrim: 5         # 捨て代コメント（保持されるべき）
  candidates: 3
  selectedPlan: null

stocks:
  - { id: 1x4-6f, label: "1x4材", kind: bar, length: 1820, width: 89, thickness: 19, price: 382 }

parts:
  # 棚板は2枚同寸のため、アンカー＆エイリアスで長さを共有する。
  - id: shelf-0
    label: 棚板0
    qty: 1
    stock: 1x4-6f
    length: &shelf_len 550
  - id: shelf-1
    label: 棚板1
    qty: 1
    stock: 1x4-6f
    length: *shelf_len
"""


def test_cli_select_preserves_comments_and_anchors_and_updates_only_selected_plan(tmp_path):
    project_path = tmp_path / "project.yaml"
    project_path.write_text(_COMMENTED_PROJECT_YAML, encoding="utf-8")

    exit_code = main(["select", "A", str(project_path)])
    assert exit_code == 0

    rewritten = project_path.read_text(encoding="utf-8")

    # コメントが保持されていること（最重要）。
    assert "# コメント保持テスト: このコメントは selectedPlan 書き換え後も残っていなければならない。" in rewritten
    assert "# 刃厚コメント（保持されるべき）" in rewritten
    assert "# 捨て代コメント（保持されるべき）" in rewritten
    assert "# 棚板は2枚同寸のため、アンカー＆エイリアスで長さを共有する。" in rewritten

    # アンカー・エイリアスが保持されていること。
    assert "&shelf_len 550" in rewritten
    assert "*shelf_len" in rewritten

    # selectedPlan だけが書き換わっていること。
    assert "selectedPlan: A" in rewritten
    assert "selectedPlan: null" not in rewritten

    # 他の値はそのまま（kerf/edgeTrim/candidates は不変）。
    assert "kerf: 3" in rewritten
    assert "edgeTrim: 5" in rewritten
    assert "candidates: 3" in rewritten

    # ラウンドトリップ後も YAML として妥当で、意図した値になっていること。
    yaml = YAML(typ="safe")
    data = yaml.load(rewritten)
    assert data["settings"]["selectedPlan"] == "A"
    assert data["parts"][0]["length"] == data["parts"][1]["length"] == 550


def test_cli_select_none_clears_selected_plan(tmp_path):
    project_path = tmp_path / "project.yaml"
    project_path.write_text(_COMMENTED_PROJECT_YAML.replace("selectedPlan: null", "selectedPlan: A"), encoding="utf-8")

    exit_code = main(["select", "none", str(project_path)])
    assert exit_code == 0

    rewritten = project_path.read_text(encoding="utf-8")
    yaml = YAML(typ="safe")
    data = yaml.load(rewritten)
    assert data["settings"]["selectedPlan"] is None


def test_cli_select_rebuilds_and_removes_stale_plan_files(tmp_path):
    project_path = tmp_path / "project.yaml"
    project_path.write_text(_COMMENTED_PROJECT_YAML, encoding="utf-8")

    assert main(["build", str(project_path)]) == 0
    out_dir = tmp_path / "out"
    assert (out_dir / "plan-A.svg").exists()
    assert (out_dir / "plan-B.svg").exists()
    assert (out_dir / "plan-C.svg").exists()

    # 管理外ファイルを混ぜておく。
    keep_file = out_dir / "keep-me.txt"
    keep_file.write_text("触れられてはいけない", encoding="utf-8")

    exit_code = main(["select", "A", str(project_path)])
    assert exit_code == 0

    assert (out_dir / "plan-A.svg").exists()
    assert not (out_dir / "plan-B.svg").exists()
    assert not (out_dir / "plan-C.svg").exists()
    assert keep_file.exists()

    summary = json.loads((out_dir / "summary.json").read_text(encoding="utf-8"))
    assert summary["selectedPlan"] == "A"
    assert [p["id"] for p in summary["plans"]] == ["A"]
