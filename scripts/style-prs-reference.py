#!/usr/bin/env python3
"""Build PRS presentation geometry from the supplied reference, retaining CMS data.

Only sheet1 and appended visual styles change. Original strings, typed cell values,
number formats, protection and other package members are retained. The combined
two-paragraph note is split across the reference's two separate note rows.
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

_spec = importlib.util.spec_from_file_location(
    "style_export_templates", Path(__file__).with_name("style-export-templates.py"))
_base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_base)
MAIN, NS = _base.MAIN, _base.NS
TAG = lambda name: f"{{{MAIN}}}{name}"
COLS = "ABCDEFGHIJKL"
ROW_MAP = {1: 1, 2: 2, 3: 3, 4: 5, 5: 6, 6: 7, 7: 9,
           8: 11, 9: 13, 10: 15, 11: 16, 12: 17, 13: 18}


class ExactVisualStyles(_base.VisualStyles):
    """Transfer donor visuals without inheriting an obsolete wrapping setting."""

    def transfer(self, original_id, reference_id, adapt_border_geometry=False):
        key = ("exact", original_id, reference_id)
        if key in self.cache:
            return self.cache[key]
        old = self.original.find("m:cellXfs", NS)[original_id]
        donor = self.reference.find("m:cellXfs", NS)[reference_id]
        result = copy.deepcopy(old)
        for name, attribute, flag in (("fonts", "fontId", "applyFont"),
                                      ("fills", "fillId", "applyFill"),
                                      ("borders", "borderId", "applyBorder")):
            visual = self.reference.find("m:" + name, NS)[int(donor.get(attribute, "0"))]
            result.set(attribute, str(self.add(name, self.resolve_theme(visual))))
            result.set(flag, "1")
        for alignment in result.findall("m:alignment", NS):
            result.remove(alignment)
        alignment = donor.find("m:alignment", NS)
        if alignment is not None:
            result.insert(0, copy.deepcopy(alignment))
            result.set("applyAlignment", "1")
        else:
            result.attrib.pop("applyAlignment", None)
        self.cache[key] = self.add("cellXfs", result)
        return self.cache[key]

    def single(self, original_id, first_id, last_id):
        first = self.transfer(original_id, first_id)
        xfs = list(self.original.find("m:cellXfs", NS)) + self.added["cellXfs"]
        borders = list(self.original.find("m:borders", NS)) + self.added["borders"]
        result = copy.deepcopy(xfs[first])
        border = copy.deepcopy(borders[int(result.get("borderId", "0"))])
        donor = self.reference.find("m:cellXfs", NS)[last_id]
        donor_border = self.reference.find("m:borders", NS)[int(donor.get("borderId", "0"))]
        for bottom in border.findall("m:bottom", NS):
            border.remove(bottom)
        bottom = donor_border.find("m:bottom", NS)
        if bottom is not None:
            position = next((index for index, edge in enumerate(border)
                             if edge.tag in (TAG("diagonal"), TAG("vertical"), TAG("horizontal"))), len(border))
            border.insert(position, self.resolve_theme(bottom))
        result.set("borderId", str(self.add("borders", border)))
        return self.add("cellXfs", result)


def coordinate(address):
    match = re.fullmatch(r"([A-Z]+)(\d+)", address)
    return match[1], int(match[2])


def cell_value(cell, strings):
    if cell is None:
        return None
    inline = cell.find("m:is", NS)
    if inline is not None:
        return "".join(inline.itertext())
    value = cell.find("m:v", NS)
    if value is None:
        return None
    return strings[int(value.text)] if cell.get("t") == "s" else value.text


def set_inline(cell, value):
    for child in list(cell):
        if child.tag in (TAG("v"), TAG("is")):
            cell.remove(child)
    cell.set("t", "inlineStr")
    text = ET.SubElement(ET.SubElement(cell, TAG("is")), TAG("t"))
    text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    text.text = value


def replace_xml(document, name, element):
    return _base.replace_element(document, name, _base.xml(element))


def format_workbook(source_bytes, donor_path, populated=False):
    with zipfile.ZipFile(io.BytesIO(source_bytes)) as source, zipfile.ZipFile(donor_path) as donor:
        source_xml = source.read("xl/worksheets/sheet1.xml").decode()
        source_sheet = ET.fromstring(source_xml)
        reference = ET.fromstring(donor.read("xl/worksheets/sheet1.xml"))
        old_rows = {int(row.get("r")): row for row in source_sheet.findall("m:sheetData/m:row", NS)}
        donor_rows = {int(row.get("r")): row for row in reference.findall("m:sheetData/m:row", NS)}
        old_cells = {cell.get("r"): cell for row in old_rows.values() for cell in row}
        donor_cells = {cell.get("r"): cell for row in donor_rows.values() for cell in row}
        strings = []
        if "xl/sharedStrings.xml" in source.namelist():
            strings = ["".join(item.itertext()) for item in ET.fromstring(source.read("xl/sharedStrings.xml"))]
        style_xml = source.read("xl/styles.xml").decode()
        styles = ExactVisualStyles(style_xml, donor.read("xl/styles.xml"), donor.read("xl/theme/theme1.xml"))
        rows = {}
        remapped = {}

        def new_row(number, donor_number=None, height=None):
            attrs = copy.deepcopy(donor_rows.get(donor_number or number, ET.Element(TAG("row"))).attrib)
            attrs["r"] = str(number)
            if height is not None:
                attrs.update(ht=str(height), customHeight="1")
            row = ET.Element(TAG("row"), attrs)
            rows[number] = row
            return row

        def styled_cell(old_address, new_address, donor_address, single=False):
            old = old_cells.get(old_address)
            cell = copy.deepcopy(old) if old is not None else ET.Element(TAG("c"))
            cell.set("r", new_address)
            old_id = int(old.get("s", "0")) if old is not None else 0
            ref_id = int(donor_cells.get(donor_address, ET.Element(TAG("c"))).get("s", "0"))
            if single:
                column, _ = coordinate(donor_address)
                last_id = int(donor_cells[f"{column}23"].get("s", "0"))
                style_id = styles.single(old_id, ref_id, last_id)
            else:
                style_id = styles.transfer(old_id, ref_id)
            cell.set("s", str(style_id))
            if old is not None and cell_value(old, strings) is not None:
                remapped[old_address] = new_address
            return cell

        inverse = {target: old for old, target in ROW_MAP.items()}
        for number in range(1, 19):
            # Excel cannot reliably auto-size the reference's merged headers.
            height = {1: 20.4, 2: 21.6, 3: 31.5, 4: 15.75, 18: 31.5}.get(number)
            row = new_row(number, height=height)
            old_number = inverse.get(number)
            for column in COLS:
                old_address = f"{column}{old_number}" if old_number else ""
                row.append(styled_cell(old_address, f"{column}{number}", f"{column}{number}"))
        note = cell_value(old_cells.get("A3"), strings)
        if note is None or "\n" not in note:
            raise ValueError("Expected original PRS two-paragraph note in A3")
        first_note, second_note = note.split("\n", 1)
        set_inline(rows[3][0], first_note)
        set_inline(rows[4][0], second_note)
        if first_note + "\n" + second_note != note:
            raise AssertionError("Original note was not preserved")

        populated_rows = [number for number in range(14, 24)
                          if any(cell_value(old_cells.get(f"{column}{number}"), strings) is not None
                                 for column in COLS)] if populated else []
        if populated and populated_rows != list(range(14, 14 + len(populated_rows))):
            raise ValueError("Expected contiguous old PRS contributor rows")
        count = len(populated_rows) if populated else 11
        footer = 19 + count + 1 if populated else 31
        groups = []
        if populated:
            for number in populated_rows:
                if cell_value(old_cells.get(f"A{number}"), strings) is not None:
                    groups.append([number, number])
                elif not groups:
                    raise ValueError("Contributor row precedes first cue sequence")
                else:
                    groups[-1][1] = number
        for offset in range(count):
            number = 19 + offset
            old_number = 14 + offset if populated else ({19: 14, 22: 15, 23: 23, 29: 14}.get(number, 15))
            if populated:
                start, end = next(group for group in groups if group[0] <= old_number <= group[1])
                single = start == end
                donor_number = 19 if old_number == start else 23 if old_number == end else 22
            else:
                single = number == 29
                donor_number = 19 if number in (19, 29) else 23 if number == 23 else 22
            row = new_row(number, donor_number, 15.75)
            for column in COLS:
                cell = styled_cell(f"{column}{old_number}", f"{column}{number}", f"{column}{donor_number}", single)
                if not populated:
                    for child in list(cell):
                        if child.tag in (TAG("v"), TAG("is"), TAG("f")):
                            cell.remove(child)
                    cell.attrib.pop("t", None)
                row.append(cell)
        new_row(footer - 1, height=15.75)
        row = new_row(footer, 31, 34)
        for column in COLS:
            row.append(styled_cell(f"{column}25", f"{column}{footer}", f"{column}31"))

        # Keep unaffected cells outside A:L and below the original managed range.
        for number, old_row in old_rows.items():
            for cell in old_row:
                column, _ = coordinate(cell.get("r"))
                outside = _base.column_number(column) > 12
                below = number > 25 and number not in rows
                if outside or below:
                    if number not in rows:
                        rows[number] = ET.Element(TAG("row"), copy.deepcopy(old_row.attrib))
                    rows[number].append(copy.deepcopy(cell))
                elif number > 25 and cell_value(cell, strings) is not None:
                    raise ValueError(f"Refusing to overwrite existing value at {cell.get('r')}")
        data = ET.Element(TAG("sheetData"))
        for number in sorted(rows):
            row = rows[number]
            row[:] = sorted(row, key=lambda cell: _base.column_number(coordinate(cell.get("r"))[0]))
            data.append(row)
        result_xml = replace_xml(source_xml, "sheetData", data)

        merges = [m.get("ref") for m in reference.findall("m:mergeCells/m:mergeCell", NS)
                  if coordinate(m.get("ref").split(":")[-1])[1] <= 18]
        if populated:
            for start, end in groups:
                start, end = start + 5, end + 5
                merges.append(f"B{start}:C{end}")
                if start < end:
                    merges += [f"{column}{start}:{column}{end}" for column in ("A", "J", "K", "L")]
            merges += [f"E{number}:F{number}" for number in range(19, 19 + count)]
        else:
            merges += [f"{start}{number}:{end}{number}" for number in range(19, 30)
                       for start, end in (("B", "C"), ("E", "F"))]
        merges.append(f"A{footer}:D{footer}")
        for merge in source_sheet.findall("m:mergeCells/m:mergeCell", NS):
            start, end = map(coordinate, merge.get("ref").split(":"))
            if _base.column_number(start[0]) > 12 or start[1] > max(25, footer):
                merges.append(merge.get("ref"))
        merge_element = ET.Element(TAG("mergeCells"), {"count": str(len(merges))})
        for reference_range in merges:
            ET.SubElement(merge_element, TAG("mergeCell"), {"ref": reference_range})
        result_xml = replace_xml(result_xml, "mergeCells", merge_element)

        columns = ET.Element(TAG("cols"))
        old_columns = source_sheet.find("m:cols", NS)
        donor_columns = reference.find("m:cols", NS)
        donor_default = reference.find("m:sheetFormatPr", NS)
        for number in range(1, 13):
            original = next((c for c in old_columns if int(c.get("min")) <= number <= int(c.get("max"))), None)
            col = copy.deepcopy(original) if original is not None else ET.Element(TAG("col"))
            donor_col = next((c for c in donor_columns if int(c.get("min")) <= number <= int(c.get("max"))), None)
            col.attrib.update(min=str(number), max=str(number), customWidth="1",
                              width=donor_col.get("width") if donor_col is not None else donor_default.get("defaultColWidth"))
            col.attrib.pop("bestFit", None)
            columns.append(col)
        for col in old_columns:
            if int(col.get("max")) > 12:
                extra = copy.deepcopy(col)
                extra.set("min", str(max(13, int(col.get("min")))))
                columns.append(extra)
        result_xml = replace_xml(result_xml, "cols", columns)
        sheet_format = copy.deepcopy(source_sheet.find("m:sheetFormatPr", NS))
        for name in ("defaultColWidth", "defaultRowHeight"):
            sheet_format.set(name, donor_default.get(name))
        result_xml = replace_xml(result_xml, "sheetFormatPr", sheet_format)
        replacements = {"xl/worksheets/sheet1.xml": result_xml.encode(),
                        "xl/styles.xml": styles.render(style_xml).encode()}
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as target:
            target.comment = source.comment
            for info in source.infolist():
                target.writestr(info, replacements.get(info.filename, source.read(info.filename)))
        summary = {"populated": populated, "headerRow": 18, "dataStart": 19,
                   "contributorRows": count, "footerRow": footer, "merges": merges,
                   "styleRows": {"first": 19, "body": 22, "last": 23, "single": 29},
                   "cellMapping": remapped, "notePreservedByJoiningA3A4": True,
                   "changedPackageMembers": sorted(replacements),
                   "addedStyles": len(styles.added["cellXfs"])}
        return output.getvalue(), summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dashboard", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--template-output", type=Path, required=True)
    parser.add_argument("--static-source", type=Path)
    parser.add_argument("--static-output", type=Path)
    parser.add_argument("--summary", type=Path)
    args = parser.parse_args()
    text = args.dashboard.read_text()
    templates = json.loads(re.search(r"window\.CueExportTemplateData=(\{.*?\});", text).group(1))
    candidate, summary = format_workbook(base64.b64decode(templates["PRS"]), args.reference)
    args.template_output.write_bytes(candidate)
    all_summaries = {"template": summary}
    if args.static_source:
        if not args.static_output:
            parser.error("--static-source requires --static-output")
        candidate, summary = format_workbook(args.static_source.read_bytes(), args.reference, populated=True)
        args.static_output.write_bytes(candidate)
        all_summaries["static"] = summary
    if args.summary:
        args.summary.write_text(json.dumps(all_summaries, indent=2) + "\n")
    print(json.dumps({kind: {key: value for key, value in summary.items()
                             if key not in ("merges", "cellMapping")}
                      for kind, summary in all_summaries.items()}, indent=2))


if __name__ == "__main__":
    main()
