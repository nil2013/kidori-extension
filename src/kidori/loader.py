"""project.yaml / project.json の読込・検証（設計正本 §2）。

読込パイプライン:
1. `read_raw` — YAML（`.json` 以外）/ JSON（`.json`）を素の dict に読み込む。
2. 層1: スキーマ検証（`schema.py` の `build_schema` を単一ソースとして再利用）。
   型・必須キー・enum・数値範囲・additionalProperties: false という
   「機械的な形」を検証する。ここでエラーがあれば dataclass 構築に進まず、
   ただちに `ProjectError` を送出する。
3. dataclass 構築（YAML キー → Python 属性名のリネームをここで行う。
   例: `edgeTrim` → `edge_trim`, `schemaVersion` → `schema_version`,
   `selectedPlan` → `selected_plan`, `from` → `from_`）。
4. 層2: 意味検証（設計正本 §2 の9項目。相互参照・物理条件などスキーマでは
   表現しきれない検証）。

`load_project(path)` はこのパイプライン全体を実行し、error があれば
`ProjectError` を送出、warning のみなら `(Project, list[Issue])` を返す。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from ruamel.yaml import YAML

from kidori.errors import Issue, ProjectError
from kidori.model import (
    Feature,
    Groove,
    Hole,
    Meta,
    Part,
    Project,
    Settings,
    Stock,
    effective_width,
)
from kidori.packing.common import EPS
from kidori.schema import build_schema

#: meta.schemaVersion の想定値。不一致は warning（設計正本 §2 層2 項目7）。
SUPPORTED_SCHEMA_VERSION = "0.2"

#: jsonschema の validator keyword → 日本語ラベルの対応表。
#: 層1（スキーマ検証）のエラーメッセージを日本語化する際に使う。
#: 未知の keyword はラベル無しでフォールバックする。
_VALIDATOR_JA: dict[str, str] = {
    "required": "必須キーが不足しています",
    "type": "型が不正です",
    "enum": "許可されていない値です",
    "const": "固定値と一致しません",
    "additionalProperties": "未知のキーが含まれています",
    "minimum": "値が小さすぎます",
    "exclusiveMinimum": "値は正の数でなければなりません",
    "maximum": "値が大きすぎます",
    "oneOf": "溝（groove）または丸穴（hole）のいずれの形式にも一致しません",
    "anyOf": "許可されている形式のいずれにも一致しません",
}


# ---------------------------------------------------------------------------
# raw 読込
# ---------------------------------------------------------------------------


def read_raw(path: Path) -> dict:
    """project.yaml / project.json を素の dict に読み込む（検証・変換なし）。

    `.json` 拡張子なら `json.load`、それ以外は ruamel.yaml の safe 相当で
    読み込む（設計正本 §2）。build.py が「schema 書き出し用の stocks 抽出」に
    使う想定の補助関数のため、スキーマ検証・意味検証は一切行わない。

    Args:
        path: project.yaml / project.json のパス。

    Returns:
        読み込んだ素の dict（トップレベルが空ファイルの場合は空 dict）。

    Raises:
        ProjectError: トップレベルがオブジェクト（マップ）でない場合。
        OSError: ファイルが読めない場合。
        Exception: YAML/JSON の構文エラー（ruamel.yaml / json の例外がそのまま伝播する）。
    """

    path = Path(path)
    if path.suffix == ".json":
        with path.open("r", encoding="utf-8") as f:
            data: Any = json.load(f)
    else:
        yaml = YAML(typ="safe")
        with path.open("r", encoding="utf-8") as f:
            data = yaml.load(f)

    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ProjectError(
            [
                Issue(
                    path="<root>",
                    message="project ファイルのトップレベルはオブジェクト（マップ）でなければなりません。",
                    severity="error",
                )
            ]
        )
    return data


def _extract_stock_ids(raw: dict) -> list[str]:
    """raw から stocks[].id の一覧を抽出する（壊れた入力でも可能な範囲で拾う）。

    stocks 部分だけでも読めればスキーマの enum 更新に使えるようにするため
    （設計正本 §7: 「stocks すら読めない場合は enum なしスキーマを書く」）、
    型が不正な要素は無視して読み取れるものだけ集める。
    """

    stocks = raw.get("stocks")
    if not isinstance(stocks, list):
        return []
    ids: list[str] = []
    for s in stocks:
        if isinstance(s, dict) and isinstance(s.get("id"), str):
            ids.append(s["id"])
    return ids


# ---------------------------------------------------------------------------
# 層1: スキーマ検証
# ---------------------------------------------------------------------------


def _format_json_path(path: Any) -> str:
    """jsonschema の ValidationError.path（deque）を `parts[2].features[0].pos` 形式にする。"""

    parts = list(path)
    out = ""
    for p in parts:
        if isinstance(p, int):
            out += f"[{p}]"
        else:
            out += f".{p}" if out else str(p)
    return out or "<root>"


def _format_schema_message(error: ValidationError) -> str:
    label = _VALIDATOR_JA.get(error.validator, "スキーマ検証エラー")
    return f"{label}: {error.message}"


def _validate_schema(raw: dict, schema: dict) -> list[Issue]:
    """層1: schema.py が生成したスキーマで raw を検証し、Issue（error）一覧を返す。"""

    validator = Draft202012Validator(schema)
    errors = list(validator.iter_errors(raw))
    errors.sort(key=lambda e: _format_json_path(e.path))
    return [
        Issue(
            path=_format_json_path(error.path),
            message=_format_schema_message(error),
            severity="error",
        )
        for error in errors
    ]


# ---------------------------------------------------------------------------
# dataclass 構築（キー名リネームはここで完結させる）
# ---------------------------------------------------------------------------


def _build_feature(raw_feature: dict) -> Feature:
    if raw_feature.get("type") == "groove":
        return Groove(
            face=raw_feature["face"],
            dir=raw_feature["dir"],
            pos=float(raw_feature["pos"]),
            width=float(raw_feature["width"]),
            depth=float(raw_feature["depth"]),
            end=raw_feature["end"],
            from_=(
                float(raw_feature["from"]) if raw_feature.get("from") is not None else None
            ),
            to=(float(raw_feature["to"]) if raw_feature.get("to") is not None else None),
        )
    # スキーマ検証(oneOf: groove/hole)を通過している前提のため、それ以外は hole。
    return Hole(
        face=raw_feature["face"],
        x=float(raw_feature["x"]),
        y=float(raw_feature["y"]),
        dia=float(raw_feature["dia"]),
        depth=(float(raw_feature["depth"]) if raw_feature.get("depth") is not None else None),
    )


def _build_project(raw: dict) -> Project:
    raw_meta = raw["meta"]
    meta = Meta(
        project=raw_meta["project"],
        units=raw_meta["units"],
        schema_version=str(raw_meta["schemaVersion"]),
    )

    raw_settings = raw.get("settings") or {}
    settings_kwargs: dict[str, Any] = {}
    if "kerf" in raw_settings:
        settings_kwargs["kerf"] = float(raw_settings["kerf"])
    if "edgeTrim" in raw_settings:
        settings_kwargs["edge_trim"] = float(raw_settings["edgeTrim"])
    if "candidates" in raw_settings:
        settings_kwargs["candidates"] = int(raw_settings["candidates"])
    if "selectedPlan" in raw_settings:
        settings_kwargs["selected_plan"] = raw_settings["selectedPlan"]
    settings = Settings(**settings_kwargs)

    stocks = tuple(
        Stock(
            id=s["id"],
            label=s["label"],
            kind=s["kind"],
            length=float(s["length"]),
            width=float(s["width"]),
            thickness=float(s["thickness"]),
            price=(float(s["price"]) if s.get("price") is not None else None),
        )
        for s in raw.get("stocks", [])
    )

    parts = tuple(
        Part(
            id=p["id"],
            label=p["label"],
            qty=int(p["qty"]),
            stock=p["stock"],
            length=float(p["length"]),
            width=(float(p["width"]) if p.get("width") is not None else None),
            rot=bool(p.get("rot", True)),
            features=tuple(_build_feature(f) for f in p.get("features", [])),
        )
        for p in raw.get("parts", [])
    )

    return Project(meta=meta, settings=settings, stocks=stocks, parts=parts)


# ---------------------------------------------------------------------------
# 層2: 意味検証（設計正本 §2 の9項目）
# ---------------------------------------------------------------------------


def _check_duplicate_ids(project: Project) -> list[Issue]:
    """項目1: stocks[].id / parts[].id の重複。"""

    issues: list[Issue] = []

    seen: dict[str, list[int]] = {}
    for i, s in enumerate(project.stocks):
        seen.setdefault(s.id, []).append(i)
    for sid, idxs in seen.items():
        if len(idxs) > 1:
            issues.append(
                Issue(
                    path=f"stocks[{idxs[-1]}].id",
                    message=f"stocks[].id が重複しています: {sid!r}（インデックス {idxs}）。",
                    severity="error",
                )
            )

    seen = {}
    for i, p in enumerate(project.parts):
        seen.setdefault(p.id, []).append(i)
    for pid, idxs in seen.items():
        if len(idxs) > 1:
            issues.append(
                Issue(
                    path=f"parts[{idxs[-1]}].id",
                    message=f"parts[].id が重複しています: {pid!r}（インデックス {idxs}）。",
                    severity="error",
                )
            )

    return issues


def _check_stock_references(project: Project) -> list[Issue]:
    """項目2: parts[].stock の参照整合（スキーマの enum と重複するが権威はこちら）。"""

    stock_ids = {s.id for s in project.stocks}
    issues: list[Issue] = []
    for i, p in enumerate(project.parts):
        if p.stock not in stock_ids:
            issues.append(
                Issue(
                    path=f"parts[{i}].stock",
                    message=f"存在しない原材 id を参照しています: {p.stock!r}。",
                    severity="error",
                )
            )
    return issues


def _check_physical_fit(project: Project, stocks_by_id: dict[str, Stock]) -> list[Issue]:
    """項目3: 物理的事前チェック（bar/sheet それぞれの詰め込み可否）。"""

    issues: list[Issue] = []
    e = project.settings.edge_trim
    for i, p in enumerate(project.parts):
        stock = stocks_by_id.get(p.stock)
        if stock is None:
            continue  # 項目2で既にエラー報告済み

        if stock.kind == "bar":
            limit = stock.length - 2.0 * e
            if p.length > limit + EPS:
                over = p.length - limit
                issues.append(
                    Issue(
                        path=f"parts[{i}].length",
                        message=(
                            f"部材長 {p.length}mm が原材 {stock.id!r} の使用可能長 "
                            f"{limit}mm（length {stock.length} − 2×edgeTrim {e}）を "
                            f"{over:.3f}mm 超過しています。"
                        ),
                        severity="error",
                    )
                )
        else:  # sheet
            if p.width is None:
                continue  # 項目4で別途エラーになる
            lu = stock.length - 2.0 * e
            wu = stock.width - 2.0 * e
            fits_no_rot = p.length <= lu + EPS and p.width <= wu + EPS
            fits_rot = p.rot and (p.width <= lu + EPS and p.length <= wu + EPS)
            if not (fits_no_rot or fits_rot):
                issues.append(
                    Issue(
                        path=f"parts[{i}].length",
                        message=(
                            f"部材 {p.length}×{p.width}mm が原材 {stock.id!r} の使用可能領域 "
                            f"{lu}×{wu}mm に収まりません（rot={p.rot} を考慮しても不可）。"
                        ),
                        severity="error",
                    )
                )
    return issues


def _check_width_consistency(project: Project, stocks_by_id: dict[str, Stock]) -> list[Issue]:
    """項目4: bar 部材の width は省略か stock.width と同値のみ許容。sheet 部材は width 必須。"""

    issues: list[Issue] = []
    for i, p in enumerate(project.parts):
        stock = stocks_by_id.get(p.stock)
        if stock is None:
            continue
        if stock.kind == "bar":
            if p.width is not None and abs(p.width - stock.width) > EPS:
                issues.append(
                    Issue(
                        path=f"parts[{i}].width",
                        message=(
                            f"bar 部材の width は省略するか原材幅と同値でなければなりません"
                            f"（指定値 {p.width}mm、原材幅 {stock.width}mm）。"
                            "挽き割り指定は v1 対象外です。"
                        ),
                        severity="error",
                    )
                )
        else:  # sheet
            if p.width is None:
                issues.append(
                    Issue(
                        path=f"parts[{i}].width",
                        message="sheet 部材には width が必須です。",
                        severity="error",
                    )
                )
    return issues


def _check_groove(
    fpath: str, g: Groove, part: Part, stock: Stock, eff_width: float
) -> list[Issue]:
    """項目5・項目6（溝）: pos±width/2 の範囲、depth、end/from/to の整合。"""

    issues: list[Issue] = []
    half = g.width / 2.0
    if g.dir == "across":
        axis_max = part.length
        running_dim = eff_width
    else:  # along
        axis_max = eff_width
        running_dim = part.length

    lo, hi = g.pos - half, g.pos + half
    if lo < -EPS or hi > axis_max + EPS:
        issues.append(
            Issue(
                path=f"{fpath}.pos",
                message=(
                    f"溝の位置 pos={g.pos}mm・width={g.width}mm が部材範囲 [0, {axis_max}] を"
                    f"超えています（占有範囲 [{lo}, {hi}]）。"
                ),
                severity="error",
            )
        )

    if g.depth > stock.thickness + EPS:
        issues.append(
            Issue(
                path=f"{fpath}.depth",
                message=f"溝深さ {g.depth}mm が原材厚み {stock.thickness}mm を超えています。",
                severity="error",
            )
        )
    elif abs(g.depth - stock.thickness) <= EPS:
        issues.append(
            Issue(
                path=f"{fpath}.depth",
                message=(
                    f"溝深さ {g.depth}mm が原材厚み {stock.thickness}mm と同値です"
                    "（実質貫通になります）。"
                ),
                severity="warning",
            )
        )

    if g.end == "through":
        if g.from_ is not None or g.to is not None:
            issues.append(
                Issue(
                    path=f"{fpath}.end",
                    message="end: through の溝に from/to を指定することはできません。",
                    severity="error",
                )
            )
    else:  # stopped
        if g.from_ is None or g.to is None:
            issues.append(
                Issue(
                    path=f"{fpath}.end",
                    message="end: stopped の溝には from・to が必須です。",
                    severity="error",
                )
            )
        else:
            valid = (
                g.from_ >= -EPS
                and g.from_ + EPS < g.to
                and g.to <= running_dim + EPS
            )
            if not valid:
                issues.append(
                    Issue(
                        path=f"{fpath}.from",
                        message=(
                            f"止め溝の範囲 from={g.from_}・to={g.to} が走行方向の部材寸法 "
                            f"[0, {running_dim}] 内で 0 ≤ from < to を満たしていません。"
                        ),
                        severity="error",
                    )
                )
    return issues


def _check_hole(fpath: str, h: Hole, part: Part, stock: Stock, eff_width: float) -> list[Issue]:
    """項目5（丸穴）: x±dia/2, y±dia/2 の範囲、depth。"""

    issues: list[Issue] = []
    half = h.dia / 2.0

    x_lo, x_hi = h.x - half, h.x + half
    if x_lo < -EPS or x_hi > part.length + EPS:
        issues.append(
            Issue(
                path=f"{fpath}.x",
                message=(
                    f"穴の位置 x={h.x}mm・dia={h.dia}mm が部材範囲 [0, {part.length}] を"
                    "超えています。"
                ),
                severity="error",
            )
        )

    y_lo, y_hi = h.y - half, h.y + half
    if y_lo < -EPS or y_hi > eff_width + EPS:
        issues.append(
            Issue(
                path=f"{fpath}.y",
                message=(
                    f"穴の位置 y={h.y}mm・dia={h.dia}mm が部材範囲 [0, {eff_width}] を"
                    "超えています。"
                ),
                severity="error",
            )
        )

    if h.depth is not None:
        if h.depth > stock.thickness + EPS:
            issues.append(
                Issue(
                    path=f"{fpath}.depth",
                    message=f"穴深さ {h.depth}mm が原材厚み {stock.thickness}mm を超えています。",
                    severity="error",
                )
            )
        elif abs(h.depth - stock.thickness) <= EPS:
            issues.append(
                Issue(
                    path=f"{fpath}.depth",
                    message=(
                        f"穴深さ {h.depth}mm が原材厚み {stock.thickness}mm と同値です"
                        "（実質貫通になります）。"
                    ),
                    severity="warning",
                )
            )
    return issues


def _check_feature_bounds(project: Project, stocks_by_id: dict[str, Stock]) -> list[Issue]:
    """項目5・項目6: features の境界・整合チェック（溝・丸穴、_check_groove/_check_hole に委譲）。"""

    issues: list[Issue] = []
    for i, p in enumerate(project.parts):
        stock = stocks_by_id.get(p.stock)
        if stock is None:
            continue
        try:
            eff_width = effective_width(p, stock)
        except ValueError:
            continue  # 項目4で既にエラー報告済み（sheet 部材の width 欠落）

        for j, feat in enumerate(p.features):
            fpath = f"parts[{i}].features[{j}]"
            if isinstance(feat, Groove):
                issues.extend(_check_groove(fpath, feat, p, stock, eff_width))
            elif isinstance(feat, Hole):
                issues.extend(_check_hole(fpath, feat, p, stock, eff_width))
    return issues


def _check_meta(project: Project) -> list[Issue]:
    """項目7: meta.units は mm 固定。meta.schemaVersion 不一致は warning。"""

    issues: list[Issue] = []
    if project.meta.units != "mm":
        issues.append(
            Issue(
                path="meta.units",
                message=f"units は mm 固定です（指定値: {project.meta.units!r}）。",
                severity="error",
            )
        )
    if project.meta.schema_version != SUPPORTED_SCHEMA_VERSION:
        issues.append(
            Issue(
                path="meta.schemaVersion",
                message=(
                    f"schemaVersion が想定バージョン {SUPPORTED_SCHEMA_VERSION!r} と"
                    f"一致しません（指定値: {project.meta.schema_version!r}）。"
                ),
                severity="warning",
            )
        )
    return issues


def _check_selected_plan(project: Project) -> list[Issue]:
    """項目8: settings.selectedPlan の範囲（candidates 依存）。

    あわせて model.py の Settings.candidates 契約（「4以上の指定は loader が
    warning を出す」）に基づき、candidates が 1〜3 の範囲外の場合の warning も
    ここで発行する（設計正本 §2 の9項目には明示列挙されていないが、model.py の
    docstring がこの責務を loader に割り当てているため実装する）。
    """

    issues: list[Issue] = []
    candidates = project.settings.candidates
    if candidates < 1 or candidates > 3:
        issues.append(
            Issue(
                path="settings.candidates",
                message=(
                    f"candidates は 1〜3 の範囲で指定してください（指定値: {candidates}）。"
                    "生成時は範囲内にクランプされます。"
                ),
                severity="warning",
            )
        )

    clamped = max(1, min(3, candidates))
    valid_ids = ["A", "B", "C"][:clamped]
    sp = project.settings.selected_plan
    if sp is not None and sp not in valid_ids:
        issues.append(
            Issue(
                path="settings.selectedPlan",
                message=(
                    f"selectedPlan={sp!r} は生成される案 ID の範囲外です"
                    f"（有効値: {valid_ids}）。"
                ),
                severity="error",
            )
        )
    return issues


def _check_bar_rot(project: Project, raw: dict, stocks_by_id: dict[str, Stock]) -> list[Issue]:
    """項目9: bar 部材への rot 指定は無意味 → warning で無視。"""

    issues: list[Issue] = []
    raw_parts = raw.get("parts", [])
    for i, p in enumerate(project.parts):
        stock = stocks_by_id.get(p.stock)
        if stock is None or stock.kind != "bar":
            continue
        raw_part = raw_parts[i] if i < len(raw_parts) and isinstance(raw_parts[i], dict) else {}
        if "rot" in raw_part:
            issues.append(
                Issue(
                    path=f"parts[{i}].rot",
                    message=(
                        "bar 部材への rot 指定は無意味です（1D割付では回転を扱いません）。"
                        "この指定は無視されます。"
                    ),
                    severity="warning",
                )
            )
    return issues


def _semantic_validate(project: Project, raw: dict) -> list[Issue]:
    """層2: 設計正本 §2 の意味検証9項目（+ candidates 範囲の warning）をすべて実行する。"""

    stocks_by_id = {s.id: s for s in project.stocks}

    issues: list[Issue] = []
    issues.extend(_check_duplicate_ids(project))
    issues.extend(_check_stock_references(project))
    issues.extend(_check_physical_fit(project, stocks_by_id))
    issues.extend(_check_width_consistency(project, stocks_by_id))
    issues.extend(_check_feature_bounds(project, stocks_by_id))
    issues.extend(_check_meta(project))
    issues.extend(_check_selected_plan(project))
    issues.extend(_check_bar_rot(project, raw, stocks_by_id))
    return issues


# ---------------------------------------------------------------------------
# 公開 API
# ---------------------------------------------------------------------------


def load_project(path: Path) -> tuple[Project, list[Issue]]:
    """project.yaml / project.json を読み込み、検証済みの Project を返す。

    パイプライン: raw 読込 → 層1（スキーマ検証） → dataclass 構築 → 層2（意味検証）。
    層1でエラーがあれば dataclass 構築には進まず、直ちに `ProjectError` を送出する
    （型・必須キーが壊れた状態では層2の相互参照チェックが安全に実行できないため）。

    Args:
        path: project.yaml / project.json のパス。

    Returns:
        `(Project, issues)`。issues には層2で検出された warning のみが含まれる
        （error が1件でもあれば ProjectError を送出するため）。

    Raises:
        ProjectError: 層1または層2で severity="error" の Issue が1件以上検出された場合。
            `ProjectError.issues` には検出された全 Issue（error・warning 双方）を含む。
    """

    path = Path(path)
    raw = read_raw(path)

    stock_ids = _extract_stock_ids(raw)
    schema = build_schema(stock_ids)

    schema_issues = _validate_schema(raw, schema)
    if any(issue.severity == "error" for issue in schema_issues):
        raise ProjectError(schema_issues)

    project = _build_project(raw)
    semantic_issues = _semantic_validate(project, raw)

    all_issues = schema_issues + semantic_issues
    if any(issue.severity == "error" for issue in all_issues):
        raise ProjectError(all_issues)

    return project, all_issues
