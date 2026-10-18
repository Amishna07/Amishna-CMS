#!/usr/bin/env python3
"""Apply reference workbook visuals to the original, sanitized CMS templates.

Run from the repository root with the user's three workbooks in --references.
Always read the immutable --source fixtures, making repeated runs deterministic.
Only styles and worksheet formatting change; workbook content is never copied.
"""

import argparse
import base64
import copy
import importlib.util
import io
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"m": MAIN, "a": DRAWING}
ET.register_namespace("", MAIN)

_validator_spec = importlib.util.spec_from_file_location(
    "excel_format_only", Path(__file__).with_name("verify-excel-format-only.py"))
_validator = importlib.util.module_from_spec(_validator_spec)
_validator_spec.loader.exec_module(_validator)


def xml(element):
    return ET.tostring(element, encoding="unicode").replace(f' xmlns="{MAIN}"', "")


def set_attribute(tag, name, value):
    pattern = rf'\s{re.escape(name)}="[^"]*"'
    replacement = f' {name}="{value}"'
    if re.search(pattern, tag):
        return re.sub(pattern, replacement, tag, count=1)
    return re.sub(r"(/?>)$", lambda match: replacement + match[0], tag, count=1)


def replace_element(document, name, replacement):
    pattern = rf"<{name}\b[^>]*(?:/>|>.*?</{name}>)"
    if not re.search(pattern, document, re.S):
        raise ValueError(f"Missing expected formatting element: {name}")
    return re.sub(pattern, lambda _: replacement, document, count=1, flags=re.S)


def append_items(document, name, items, previous_count):
    if not items:
        return document
    pattern = rf"(<{name}\b[^>]*>)(.*?)(</{name}>)"
    return re.sub(pattern, lambda match: set_attribute(match[1], "count", previous_count + len(items))
                  + match[2] + "".join(map(xml, items)) + match[3], document, count=1, flags=re.S)


def column_number(letters):
    result = 0
    for letter in letters:
        result = result * 26 + ord(letter) - 64
    return result


class VisualStyles:
    def __init__(self, original, reference, theme, preserve_border_geometry=False):
        self.original = ET.fromstring(original)
        self.reference = ET.fromstring(reference)
        self.theme = ET.fromstring(theme)
        self.preserve_border_geometry = preserve_border_geometry
        self.added = {name: [] for name in ("fonts", "fills", "borders", "cellXfs")}
        self.cache = {}

    def resolve_theme(self, element):
        result = copy.deepcopy(element)
        colors = list(self.theme.find("a:themeElements/a:clrScheme", NS))
        # OOXML theme indexes use lt1, dk1, lt2, dk2, followed by the accents.
        indexed_colors = [colors[i] for i in (1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11)]
        for node in result.iter():
            if "theme" in node.attrib:
                color = indexed_colors[int(node.attrib.pop("theme"))][0]
                node.set("rgb", "FF" + color.get("lastClr", color.get("val")))
        if result.tag == f"{{{MAIN}}}font":
            default = self.reference.find("m:fonts/m:font", NS)
            for name in ("name", "sz"):
                if result.find("m:" + name, NS) is None:
                    fallback = default.find("m:" + name, NS)
                    if fallback is not None:
                        result.append(copy.deepcopy(fallback))
            scheme = result.find("m:scheme", NS)
            if scheme is not None:
                # Explicit reference font names must not inherit the old theme.
                result.remove(scheme)
        return result

    def add(self, name, element):
        key = (name, xml(element))
        if key not in self.cache:
            self.cache[key] = len(self.original.find("m:" + name, NS)) + len(self.added[name])
            self.added[name].append(element)
        return self.cache[key]

    def border_for_existing_grid(self, original, reference):
        # PRS reference cues are vertically merged. Their missing/staggered edges
        # must not be transplanted into the existing, unmerged contributor rows.
        result = copy.deepcopy(original)
        donor_edges = [edge for edge in reference if edge.get("style")]
        for index, edge in enumerate(list(result)):
            if not edge.get("style") or not donor_edges:
                continue
            same_weight = [donor for donor in donor_edges if donor.get("style") == edge.get("style")]
            candidates = same_weight or donor_edges
            chosen = next((donor for donor in candidates if donor.tag == edge.tag), candidates[0])
            replacement = copy.deepcopy(chosen)
            replacement.tag = edge.tag
            result.remove(edge)
            result.insert(index, replacement)
        return result

    def transfer(self, original_id, reference_id, adapt_border_geometry=False):
        key = (original_id, reference_id, adapt_border_geometry)
        if key in self.cache:
            return self.cache[key]
        old = self.original.find("m:cellXfs", NS)[original_id]
        donor = self.reference.find("m:cellXfs", NS)[reference_id]
        result = copy.deepcopy(old)
        for name, attribute, flag in (("fonts", "fontId", "applyFont"),
                                      ("fills", "fillId", "applyFill"),
                                      ("borders", "borderId", "applyBorder")):
            visual = self.reference.find("m:" + name, NS)[int(donor.get(attribute, "0"))]
            if name == "borders" and self.preserve_border_geometry and adapt_border_geometry:
                original_border = self.original.find("m:borders", NS)[int(old.get(attribute, "0"))]
                visual = self.border_for_existing_grid(original_border, visual)
            result.set(attribute, str(self.add(name, self.resolve_theme(visual))))
            result.set(flag, "1")
        alignment = copy.deepcopy(donor.find("m:alignment", NS))
        old_alignment = result.find("m:alignment", NS)
        if old_alignment is not None:
            if old_alignment.get("wrapText") == "1":
                if alignment is None:
                    alignment = ET.Element(f"{{{MAIN}}}alignment")
                alignment.set("wrapText", "1")
            result.remove(old_alignment)
        if alignment is not None:
            result.insert(0, alignment)
            result.set("applyAlignment", "1")
        else:
            result.attrib.pop("applyAlignment", None)
        # numFmtId, xfId, protection and all non-visual flags remain original.
        self.cache[key] = self.add("cellXfs", result)
        return self.cache[key]

    def render(self, original):
        for name, added in self.added.items():
            original = append_items(original, name, added, len(self.original.find("m:" + name, NS)))
        return original


def donor_row(society, row, style):
    if society == "PRS":
        header = {1: 1, 2: 2, 3: 3, 4: 5, 5: 6, 6: 7, 7: 9, 8: 11,
                  9: 13, 10: 15, 11: 16, 12: 17, 13: 18, 25: 31}
        if row in header:
            return header[row]
        if 14 <= row <= 23:
            return 20 if style in (15, 16, 17, 19, 39, 40, 49) else 22 if style == 48 else 19
    elif society == "IPRS":
        if row <= 15:
            return row
        if 16 <= row <= 29:
            return 16 if row == 16 else 17 if row == 29 else 19
        if 31 <= row <= 34:
            return row - 3
        if row == 36:
            return 34
    elif society == "ASCAP":
        if row <= 9:
            return row
        if row <= 14:
            return 10
        if row <= 20:
            return row - 1
    return None


def row_height(society, row, current, reference_height):
    if society == "IPRS":
        if 16 <= row <= 29:
            return 15.75
        if row <= 15:
            return max(current, reference_height, 44.4 if row == 15 else 0)
    elif society == "PRS":
        if 6 <= row <= 9:
            return max(current, 31.5)
        if 1 <= row <= 23:
            return max(current, reference_height)
        if row == 25:
            return max(current, reference_height, 34)
    elif society == "ASCAP":
        if 10 <= row <= 14:
            return 34.5
        if row == 20:
            return max(current, reference_height, 35)
        if row <= 19:
            return max(current, reference_height)
    return None


def format_sheet(society, original, reference, styles):
    source = ET.fromstring(original)
    donor = ET.fromstring(reference)
    donor_cells = {cell.get("r"): cell for cell in donor.findall("m:sheetData/m:row/m:c", NS)}
    donor_rows = {int(row.get("r")): row for row in donor.findall("m:sheetData/m:row", NS)}
    original_default = source.find("m:sheetFormatPr", NS)
    donor_default = donor.find("m:sheetFormatPr", NS)
    active_columns = {"IPRS": 13, "PRS": 12, "ASCAP": 7}[society]

    def style_cell(match):
        tag = match[0]
        position = re.search(r'\br="([A-Z]+)(\d+)"', tag)
        if not position or column_number(position[1]) > active_columns:
            return tag
        current = re.search(r'\bs="(\d+)"', tag)
        old_id = int(current[1]) if current else 0
        row = donor_row(society, int(position[2]), old_id)
        donor_cell = donor_cells.get(f"{position[1]}{row}")
        if donor_cell is None:
            return tag
        source_row = int(position[2])
        # Only metadata and cue rows differ in merge geometry. Titles, section
        # headings and the footer can use the reference's complete borders.
        adapt_border_geometry = society == "PRS" and (6 <= source_row <= 10 or 14 <= source_row <= 23)
        new_id = styles.transfer(old_id, int(donor_cell.get("s", "0")), adapt_border_geometry)
        return set_attribute(tag, "s", new_id)

    original = re.sub(r"<c\b[^>]*>", style_cell, original)

    def size_row(match):
        tag = match[0]
        row = int(re.search(r'\br="(\d+)"', tag)[1])
        mapped_row = donor_row(society, row, 0)
        if mapped_row is None:
            return tag
        donor_attributes = donor_rows[mapped_row].attrib if mapped_row in donor_rows else {}
        donor_height = float(donor_attributes.get("ht", donor_default.get("defaultRowHeight", "15")))
        current = re.search(r'\bht="([^"]+)"', tag)
        height = row_height(society, row, float(current[1]) if current else float(original_default.get("defaultRowHeight", "15")), donor_height)
        if height is None:
            return tag
        return set_attribute(set_attribute(tag, "ht", f"{height:g}"), "customHeight", "1")

    original = re.sub(r"<row\b[^>]*>", size_row, original)
    # Preserve non-size column attributes and every column outside the active grid.
    columns = ET.Element(f"{{{MAIN}}}cols")
    old_columns = source.find("m:cols", NS)
    ref_columns = donor.find("m:cols", NS)
    for number in range(1, active_columns + 1):
        previous = next((c for c in old_columns if int(c.get("min")) <= number <= int(c.get("max"))), None)
        new = copy.deepcopy(previous) if previous is not None else ET.Element(f"{{{MAIN}}}col")
        reference_column = next((c for c in ref_columns if int(c.get("min")) <= number <= int(c.get("max"))), None)
        new.set("min", str(number))
        new.set("max", str(number))
        new.set("width", reference_column.get("width") if reference_column is not None else donor_default.get("defaultColWidth"))
        new.set("customWidth", "1")
        new.attrib.pop("bestFit", None)
        columns.append(new)
    for previous in old_columns:
        if int(previous.get("max")) > active_columns:
            remaining = copy.deepcopy(previous)
            remaining.set("min", str(max(active_columns + 1, int(previous.get("min")))))
            columns.append(remaining)
    original = replace_element(original, "cols", xml(columns))
    original = re.sub(r"<sheetFormatPr\b[^>]*>", lambda match: set_attribute(
        set_attribute(match[0], "defaultColWidth", donor_default.get("defaultColWidth")),
        "defaultRowHeight", donor_default.get("defaultRowHeight")), original, count=1)
    for element_name in ("pageMargins", "pageSetup"):
        reference_element = donor.find("m:" + element_name, NS)
        if reference_element is not None:
            for attribute, value in reference_element.attrib.items():
                original = re.sub(rf"<{element_name}\b[^>]*>", lambda match, a=attribute, v=value:
                                  set_attribute(match[0], a, v), original, count=1)
    return original


def format_workbook(society, baseline, reference):
    with zipfile.ZipFile(baseline) as source, zipfile.ZipFile(reference) as donor:
        style_xml = source.read("xl/styles.xml").decode()
        styles = VisualStyles(style_xml, donor.read("xl/styles.xml"), donor.read("xl/theme/theme1.xml"),
                              preserve_border_geometry=society == "PRS")
        replacements = {}
        for path in source.namelist():
            if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", path):
                replacements[path] = format_sheet(society, source.read(path).decode(),
                                                  donor.read("xl/worksheets/sheet1.xml").decode(), styles).encode()
        replacements["xl/styles.xml"] = styles.render(style_xml).encode()
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as target:
            target.comment = source.comment
            for info in source.infolist():
                target.writestr(info, replacements.get(info.filename, source.read(info.filename)))
        candidate = output.getvalue()
        # Verify the complete package before callers can replace an existing file.
        # This also protects blank cells, hidden rows/columns, validations and
        # protection settings that a values-only comparison would miss.
        _validator.assert_format_only(Path(baseline).read_bytes(), candidate)
        return base64.b64encode(candidate).decode(), len(styles.added["cellXfs"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("frontend/tests/fixtures/export-formatting"))
    parser.add_argument("--references", type=Path, required=True)
    parser.add_argument("--target", type=Path, default=Path("frontend/public/dashboard.js"))
    args = parser.parse_args()
    document = args.target.read_text()
    assignment = re.search(r"window\.CueExportTemplateData=(\{[^\n]+\});", document)
    if assignment is None:
        raise ValueError("Embedded export template assignment not found")
    templates = json.loads(assignment[1])
    for society in templates:
        candidate, count = format_workbook(society, args.source / f"{society}-before.xlsx",
                                           args.references / f"Chashni (1 - 10) - {society}.xlsx")
        _validator.assert_format_only(base64.b64decode(templates[society]), base64.b64decode(candidate))
        templates[society] = candidate
        print(f"{society}: appended {count} visual styles; original content and style IDs preserved")
    document = document[:assignment.start(1)] + json.dumps(templates, separators=(",", ":")) + document[assignment.end(1):]
    args.target.write_text(document)


if __name__ == "__main__":
    main()
