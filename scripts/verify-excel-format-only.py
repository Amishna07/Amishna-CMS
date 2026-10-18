#!/usr/bin/env python3
"""Reject XLSX changes outside an explicit, content-preserving visual allowlist."""

import argparse
import io
import json
import re
import zipfile
from collections.abc import Mapping
from pathlib import Path
from xml.etree import ElementTree as ET


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
APPEND_ONLY = {"fonts", "fills", "borders", "cellXfs"}
VISUAL_XF_ATTRIBUTES = {"fontId", "fillId", "borderId", "applyFont", "applyFill",
                        "applyBorder", "applyAlignment"}
VISUAL_ATTRIBUTES = {
    "row": {"ht", "customHeight"},
    "sheetFormatPr": {"defaultColWidth", "defaultRowHeight"},
    "pageMargins": {"left", "right", "top", "bottom", "header", "footer"},
    # Relationship IDs, copy counts and any unlisted settings remain unchanged.
    "pageSetup": {"paperSize", "scale", "firstPageNumber", "fitToWidth", "fitToHeight",
                  "pageOrder", "orientation", "blackAndWhite", "draft",
                  "useFirstPageNumber", "horizontalDpi", "verticalDpi"},
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def local_name(element):
    return element.tag.removeprefix("{" + MAIN + "}")


def canonical(element, ignored_attributes=frozenset(), ignored_children=frozenset()):
    return (element.tag,
            tuple(sorted((key, value) for key, value in element.attrib.items()
                         if key not in ignored_attributes)),
            element.text, element.tail,
            tuple(canonical(child) for child in element if child.tag not in ignored_children))


def parse_xml(data, name):
    try:
        return ET.fromstring(data)
    except ET.ParseError as error:
        raise ValueError(f"Invalid XML in {name}: {error}") from error


def index(value, length, label):
    require(re.fullmatch(r"\d+", value) is not None, f"Invalid {label}: {value}")
    result = int(value)
    require(result < length, f"Out-of-range {label}: {value}")
    return result


class Styles:
    def __init__(self, data, label):
        self.root = parse_xml(data, label + " styles.xml")
        self.collections = {local_name(child): child for child in self.root}
        self.xfs = self.collections.get("cellXfs")
        require(self.xfs is not None and len(self.xfs) > 0, label + ": missing cell styles")
        for name in APPEND_ONLY:
            collection = self.collections.get(name)
            require(collection is not None, label + ": missing " + name)
            require(collection.get("count", str(len(collection))) == str(len(collection)),
                    label + ": invalid " + name + " count")
        custom_formats = {element.get("numFmtId") for element in self.collections.get("numFmts", [])}
        for collection_name in ("cellXfs", "cellStyleXfs"):
            for xf in self.collections.get(collection_name, []):
                for attribute, collection in (("fontId", "fonts"), ("fillId", "fills"),
                                              ("borderId", "borders")):
                    index(xf.get(attribute, "0"), len(self.collections[collection]), label + " " + attribute)
                if "xfId" in xf.attrib:
                    index(xf.get("xfId"), len(self.collections.get("cellStyleXfs", [])), label + " xfId")
                number_format = xf.get("numFmtId", "0")
                require(re.fullmatch(r"\d+", number_format) is not None,
                        label + ": invalid number format ID")
                require(int(number_format) < 164 or number_format in custom_formats,
                        label + ": unknown number format ID " + number_format)
        for cell_style in self.collections.get("cellStyles", []):
            index(cell_style.get("xfId", "0"), len(self.collections.get("cellStyleXfs", [])),
                  label + " cellStyle xfId")

    def nonvisual(self, style_id):
        xf = self.xfs[index(style_id, len(self.xfs), "cell style")]
        return canonical(xf, VISUAL_XF_ATTRIBUTES, {"{" + MAIN + "}alignment"})


def assert_styles_preserved(before, after):
    require(before.root.tag == after.root.tag and before.root.attrib == after.root.attrib
            and before.root.text == after.root.text and before.root.tail == after.root.tail,
            "Style root changed")
    require([child.tag for child in before.root] == [child.tag for child in after.root],
            "Style collections changed")
    for old, new in zip(before.root, after.root):
        name = local_name(old)
        if name in APPEND_ONLY:
            require({k: v for k, v in old.attrib.items() if k != "count"}
                    == {k: v for k, v in new.attrib.items() if k != "count"}
                    and old.text == new.text and old.tail == new.tail,
                    "Non-format style collection attributes changed: " + name)
            require(len(new) >= len(old), "Existing styles removed: " + name)
            require(all(canonical(a) == canonical(b) for a, b in zip(old, new)),
                    "Existing styles modified: " + name)
        else:
            require(canonical(old) == canonical(new), "Non-format styles changed: " + name)


def worksheet_signature(root, styles, collapsed_rows=frozenset()):
    collapsed_elements = {row for row in root.findall(f"{{{MAIN}}}sheetData/{{{MAIN}}}row")
                          if row.get("r") in collapsed_rows}

    def visit(element):
        name = local_name(element)
        if name == "cols":
            # Width changes can split an existing range into single columns.
            # Expand ranges to compare all other properties at each column.
            columns = {}
            for column in element:
                require(local_name(column) == "col", "Unexpected column element")
                first = index(column.get("min", ""), 16385, "column minimum")
                last = index(column.get("max", ""), 16385, "column maximum")
                require(1 <= first <= last, "Invalid column range")
                attrs = {key: value for key, value in column.attrib.items()
                         if key not in {"min", "max", "width", "customWidth", "bestFit", "style"}}
                attrs["effective-style"] = styles.nonvisual(column.get("style", "0"))
                require(not list(column) and column.text is None, "Unexpected column contents")
                signature = tuple(sorted(attrs.items()))
                for number in range(first, last + 1):
                    require(number not in columns, "Overlapping column definitions")
                    columns[number] = signature
            default = (("effective-style", styles.nonvisual("0")),)
            # Explicit width-only definitions are equivalent to unspecified columns.
            return (element.tag, tuple(sorted(element.attrib.items())), element.text, element.tail,
                    tuple((number, signature) for number, signature in sorted(columns.items())
                          if signature != default))
        attrs = {key: value for key, value in element.attrib.items()
                 if key not in VISUAL_ATTRIBUTES.get(name, set())}
        if name in {"c", "row"}:
            attrs.pop("s", None)
            attrs["effective-style"] = styles.nonvisual(element.get("s", "0"))
        if element in collapsed_elements:
            # Only rows validated as empty, explicitly requested spacers reach here.
            attrs.pop("hidden", None)
        return (element.tag, tuple(sorted(attrs.items())), element.text, element.tail,
                tuple(visit(child) for child in element))
    return visit(root)


def assert_collapsed_rows(before, after, row_numbers, worksheet):
    """Approve only explicit visible-to-hidden transitions of empty spacer rows."""
    if not row_numbers:
        return
    row_path = f"{{{MAIN}}}sheetData/{{{MAIN}}}row"
    old_rows, new_rows = before.findall(row_path), after.findall(row_path)
    content_tags = {f"{{{MAIN}}}{name}" for name in ("v", "is", "f")}
    for number in row_numbers:
        label = f"{worksheet} row {number}"
        old = [row for row in old_rows if row.get("r") == number]
        new = [row for row in new_rows if row.get("r") == number]
        require(len(old) == len(new) == 1, "Collapsed spacer must exist exactly once: " + label)
        old, new = old[0], new[0]
        require(not any(element.tag in content_tags for row in (old, new) for element in row.iter()),
                "Collapsed spacer must contain no values, inline strings or formulas: " + label)
        require(old.get("hidden") in (None, "0", "false"),
                "Collapsed spacer must originally be visible: " + label)
        require(new.get("hidden") in ("1", "true")
                and re.fullmatch(r"0+(?:\.0+)?", new.get("ht", "")) is not None
                and new.get("customHeight") in ("1", "true"),
                "Collapsed spacer must be hidden with zero custom height: " + label)


def assert_format_only(before_bytes, after_bytes, collapsed_rows=None):
    """Verify visual-only changes; opt in to hiding named, empty spacer rows.

    collapsed_rows maps worksheet package paths to their original row numbers.
    By default every hidden flag is protected, including flags on empty rows.
    """
    require(collapsed_rows is None or isinstance(collapsed_rows, Mapping),
            "Collapsed spacer allowlist must map worksheet paths to row numbers")
    allowed_rows = {}
    for worksheet, numbers in (collapsed_rows or {}).items():
        require(isinstance(worksheet, str)
                and re.fullmatch(r"xl/worksheets/[^/]+\.xml", worksheet) is not None,
                "Invalid collapsed spacer worksheet path")
        try:
            numbers = list(numbers)
        except TypeError as error:
            raise ValueError("Collapsed spacer row numbers must be iterable") from error
        require(all(re.fullmatch(r"[1-9]\d*", str(number)) is not None
                    and int(number) <= 1048576 for number in numbers),
                "Invalid collapsed spacer row number: " + worksheet)
        allowed_rows[worksheet] = {str(number) for number in numbers}
    try:
        with zipfile.ZipFile(io.BytesIO(before_bytes)) as before, \
                zipfile.ZipFile(io.BytesIO(after_bytes)) as after:
            names = before.namelist()
            require(len(names) == len(set(names)), "Original package has duplicate members")
            require(names == after.namelist(), "Workbook package members or their order changed")
            require(set(allowed_rows).issubset(names), "Collapsed spacer worksheet is missing")
            require(before.comment == after.comment, "Workbook package comment changed")
            require("xl/styles.xml" in names, "Workbook styles are missing")
            old_styles = Styles(before.read("xl/styles.xml"), "Original")
            new_styles = Styles(after.read("xl/styles.xml"), "Updated")
            assert_styles_preserved(old_styles, new_styles)
            worksheets = 0
            changed_parts = []
            for name in names:
                old, new = before.read(name), after.read(name)
                if old != new:
                    changed_parts.append(name)
                if name == "xl/styles.xml":
                    continue
                if re.fullmatch(r"xl/worksheets/[^/]+\.xml", name):
                    worksheets += 1
                    old_root = parse_xml(old, name)
                    new_root = parse_xml(new, name)
                    permitted = allowed_rows.get(name, frozenset())
                    assert_collapsed_rows(old_root, new_root, permitted, name)
                    require(worksheet_signature(old_root, old_styles, permitted)
                            == worksheet_signature(new_root, new_styles, permitted),
                            "Worksheet content, structure or nonvisual settings changed: " + name)
                else:
                    require(old == new, "Non-format workbook part changed: " + name)
            return {"worksheets": worksheets, "parts": len(names), "changed_parts": changed_parts}
    except (zipfile.BadZipFile, KeyError) as error:
        raise ValueError(f"Invalid workbook package: {error}") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path)
    parser.add_argument("updated", type=Path)
    args = parser.parse_args()
    print(json.dumps(assert_format_only(args.original.read_bytes(), args.updated.read_bytes()), indent=2))


if __name__ == "__main__":
    main()
