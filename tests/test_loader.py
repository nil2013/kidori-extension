"""loader.py のテスト（設計正本 §10 項目2、および §2 層2 の意味検証9項目）。

構成:
- 基本の読込（YAML/JSON、raw 読込の型エラー）
- SPECS §4 の例 YAML が意味検証層で物理的事前チェック（項目3）に引っかかること
  （conftest.py の SPECS_EXAMPLE_YAML docstring 参照。意図した挙動）
- §10 項目2: 詰め込み可否境界（bar の length == L-2e / +0.1、sheet の
  「回転すれば入る」部材の rot:false/true）
- 意味検証9項目（設計正本 §2 層2）それぞれに対応するテスト
"""

from __future__ import annotations

import copy

import pytest

from kidori.errors import ProjectError
from kidori.loader import _check_stock_references, load_project
from kidori.model import Meta, Part, Project, Settings, Stock

EDGE_TRIM = 5
BAR_LENGTH = 1820  # minimal_project の "1x4-6f" stock
BAR_LIMIT = BAR_LENGTH - 2 * EDGE_TRIM  # 1810


# ---------------------------------------------------------------------------
# 基本の読込
# ---------------------------------------------------------------------------


def test_load_project_minimal_succeeds_without_issues(minimal_project, yaml_writer) -> None:
    path = yaml_writer(minimal_project)
    project, issues = load_project(path)

    assert issues == []
    assert project.meta.project == "テスト棚"
    assert len(project.stocks) == 2
    assert len(project.parts) == 2
    assert project.parts[0].id == "shelf-0"
    assert project.parts[0].qty == 2
    assert project.parts[1].features[0].pos == 248


def test_load_project_json_input(minimal_project, json_writer) -> None:
    path = json_writer(minimal_project)
    project, issues = load_project(path)

    assert issues == []
    assert len(project.stocks) == 2


def test_read_raw_non_dict_top_level_raises(tmp_path) -> None:
    path = tmp_path / "project.yaml"
    path.write_text("- 1\n- 2\n", encoding="utf-8")

    with pytest.raises(ProjectError):
        load_project(path)


def test_specs_example_raises_due_to_physical_fit(specs_example_project_file) -> None:
    """SPECS.md §4a の例（side-0 length 1985 > pine-18 length 1820、rot: false）は
    意味検証層の物理的事前チェック（項目3）で error になる（意図した挙動）。
    """

    with pytest.raises(ProjectError) as err:
        load_project(specs_example_project_file)

    messages = [i.message for i in err.value.issues]
    assert any("parts[0].length" == i.path for i in err.value.issues)
    assert any("収まりません" in m for m in messages)


# ---------------------------------------------------------------------------
# §10 項目2: 詰め込み可否境界
# ---------------------------------------------------------------------------


def test_bar_length_exactly_at_limit_is_valid(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][0]["length"] = BAR_LIMIT  # 1810 == L - 2e ちょうど

    path = yaml_writer(data)
    project, issues = load_project(path)

    assert issues == []
    assert project.parts[0].length == BAR_LIMIT


def test_bar_length_over_limit_by_0_1_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][0]["length"] = BAR_LIMIT + 0.1

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "parts[0].length" for i in err.value.issues)


def test_sheet_rot_false_fails_when_only_rotation_fits(minimal_project, yaml_writer) -> None:
    # ply-12: length=1820, width=910, edgeTrim=5 → Lu=1810, Wu=900
    # length=850, width=950: 無回転では w(950) > Wu(900) で不可。
    # 回転すれば w(950) <= Lu(1810) かつ l(850) <= Wu(900) で可能。
    data = copy.deepcopy(minimal_project)
    data["parts"] = [
        {
            "id": "rot-test",
            "label": "回転テスト",
            "qty": 1,
            "stock": "ply-12",
            "length": 850,
            "width": 950,
            "rot": False,
        }
    ]

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "parts[0].length" for i in err.value.issues)


def test_sheet_rot_true_succeeds_when_only_rotation_fits(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"] = [
        {
            "id": "rot-test",
            "label": "回転テスト",
            "qty": 1,
            "stock": "ply-12",
            "length": 850,
            "width": 950,
            "rot": True,
        }
    ]

    path = yaml_writer(data)
    project, issues = load_project(path)

    assert issues == []
    assert project.parts[0].rot is True


# ---------------------------------------------------------------------------
# 意味検証9項目（設計正本 §2 層2）
# ---------------------------------------------------------------------------


# 項目1: stocks[].id / parts[].id の重複 → error
def test_duplicate_stock_id_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["stocks"][1]["id"] = data["stocks"][0]["id"]
    # stock 参照が壊れないよう parts 側も揃える
    for p in data["parts"]:
        p["stock"] = data["stocks"][0]["id"]
        p.pop("width", None)

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any("重複" in i.message for i in err.value.issues)


def test_duplicate_part_id_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][1]["id"] = data["parts"][0]["id"]

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any("重複" in i.message for i in err.value.issues)


# 項目2: parts[].stock の参照整合（enum と重複するが権威は意味検証層）
# schema 層の enum がまず捕捉するため、意味検証層自体の関数を直接確認する。
def test_check_stock_references_flags_missing_stock_directly() -> None:
    project = Project(
        meta=Meta(project="p", units="mm", schema_version="0.2"),
        settings=Settings(),
        stocks=(
            Stock(id="s1", label="s1", kind="bar", length=1000, width=50, thickness=20),
        ),
        parts=(
            Part(id="p1", label="p1", qty=1, stock="does-not-exist", length=100),
        ),
    )

    issues = _check_stock_references(project)

    assert len(issues) == 1
    assert issues[0].path == "parts[0].stock"
    assert issues[0].severity == "error"


def test_load_project_invalid_stock_reference_raises_via_full_pipeline(
    minimal_project, yaml_writer
) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][0]["stock"] = "does-not-exist"

    path = yaml_writer(data)
    with pytest.raises(ProjectError):
        load_project(path)


# 項目3: 物理的事前チェック → §10 項目2 のテスト群でカバー済み


# 項目4: bar 部材の width 整合・sheet 部材の width 必須
def test_bar_width_mismatch_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][0]["width"] = data["stocks"][0]["width"] + 1

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "parts[0].width" for i in err.value.issues)


def test_sheet_missing_width_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    del data["parts"][1]["width"]

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "parts[1].width" for i in err.value.issues)


# 項目5: feature 境界（groove の pos±width/2、hole の x±dia/2, y±dia/2、depth）
def test_groove_pos_out_of_range_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][1]["features"][0]["pos"] = 800  # part.length と同値 → はみ出す

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "parts[1].features[0].pos" for i in err.value.issues)


def test_hole_out_of_range_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][1]["features"][1]["y"] = 310  # eff_width(300) を超える

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "parts[1].features[1].y" for i in err.value.issues)


def test_groove_depth_exceeds_thickness_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][1]["features"][0]["depth"] = 15  # ply-12 の thickness(12) を超える

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "parts[1].features[0].depth" for i in err.value.issues)


def test_groove_depth_equal_thickness_is_warning_only(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][1]["features"][0]["depth"] = 12  # ply-12 の thickness と同値

    path = yaml_writer(data)
    project, issues = load_project(path)

    assert project is not None
    assert any(
        i.path == "parts[1].features[0].depth" and i.severity == "warning" for i in issues
    )


# 項目6: groove の end/from/to 整合
def test_groove_through_with_from_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][1]["features"][0]["from"] = 10

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "parts[1].features[0].end" for i in err.value.issues)


def test_groove_stopped_without_from_to_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][1]["features"][0]["end"] = "stopped"

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "parts[1].features[0].end" for i in err.value.issues)


def test_groove_stopped_invalid_range_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][1]["features"][0]["end"] = "stopped"
    data["parts"][1]["features"][0]["from"] = 500
    data["parts"][1]["features"][0]["to"] = 100  # from >= to で不正

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "parts[1].features[0].from" for i in err.value.issues)


def test_groove_stopped_valid_range_succeeds(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][1]["features"][0]["end"] = "stopped"
    data["parts"][1]["features"][0]["from"] = 100
    data["parts"][1]["features"][0]["to"] = 250  # eff_width(300) 内

    path = yaml_writer(data)
    project, issues = load_project(path)

    assert issues == []
    groove = project.parts[1].features[0]
    assert groove.from_ == 100
    assert groove.to == 250


# 項目7: meta.units 固定・schemaVersion 不一致
def test_meta_units_invalid_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["meta"]["units"] = "cm"

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "meta.units" for i in err.value.issues)


def test_meta_schema_version_mismatch_is_warning_only(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["meta"]["schemaVersion"] = "0.1"

    path = yaml_writer(data)
    project, issues = load_project(path)

    assert project is not None
    assert any(i.path == "meta.schemaVersion" and i.severity == "warning" for i in issues)


# 項目8: settings.selectedPlan の範囲（+ model.py 契約の candidates クランプ警告）
def test_selected_plan_out_of_candidates_range_is_error(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["settings"]["candidates"] = 1
    data["settings"]["selectedPlan"] = "B"  # candidates=1 なら "A" のみ有効

    path = yaml_writer(data)
    with pytest.raises(ProjectError) as err:
        load_project(path)

    assert any(i.path == "settings.selectedPlan" for i in err.value.issues)


def test_candidates_out_of_range_is_warning_only(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["settings"]["candidates"] = 5

    path = yaml_writer(data)
    project, issues = load_project(path)

    assert project is not None
    assert any(i.path == "settings.candidates" and i.severity == "warning" for i in issues)


# 項目9: bar 部材への rot 指定は無意味 → warning
def test_bar_rot_specified_is_warning_only(minimal_project, yaml_writer) -> None:
    data = copy.deepcopy(minimal_project)
    data["parts"][0]["rot"] = True  # shelf-0 は bar 部材

    path = yaml_writer(data)
    project, issues = load_project(path)

    assert project is not None
    assert any(i.path == "parts[0].rot" and i.severity == "warning" for i in issues)


def test_bar_rot_not_specified_has_no_warning(minimal_project, yaml_writer) -> None:
    path = yaml_writer(minimal_project)
    project, issues = load_project(path)

    assert issues == []
