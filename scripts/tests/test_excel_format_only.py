"""Exercise preservation failures that value-only spreadsheet checks can miss."""

import base64
import importlib.util
import io
import re
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def load_module(filename):
    spec = importlib.util.spec_from_file_location(filename, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VERIFY = load_module("verify-excel-format-only.py")
FORMAT = load_module("style-export-templates.py")


def mutate(workbook, path, transform):
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(workbook)) as source, zipfile.ZipFile(output, "w") as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == path:
                data = transform(data.decode()).encode()
            target.writestr(info, data)
    return output.getvalue()


class FormatOnlyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = (ROOT / "frontend/tests/fixtures/export-formatting/IPRS-before.xlsx").read_bytes()
        cls.spacers = mutate(cls.before, "xl/worksheets/sheet1.xml", lambda xml: xml.replace(
            '</sheetData>', '<row r="10000"><c r="A10000"/></row><row r="10001"><c r="A10001"/></row></sheetData>'))
        cls.collapsed = mutate(cls.spacers, "xl/worksheets/sheet1.xml", lambda xml: xml.replace(
            '<row r="10000">', '<row r="10000" hidden="1" ht="0" customHeight="1">'))

    def test_collapsed_empty_spacer_requires_explicit_row_allowlist(self):
        for allowed in (None, {}, {"xl/worksheets/sheet1.xml": [10001]},
                        {"xl/worksheets/sheet1.xml": [10999]},
                        {"xl/worksheets/sheet2.xml": [10000]}):
            with self.subTest(allowed=allowed), self.assertRaises(ValueError):
                VERIFY.assert_format_only(self.spacers, self.collapsed, collapsed_rows=allowed)

    def test_explicit_empty_spacer_collapse_passes_for_xml_boolean_values(self):
        for old_hidden in ('', ' hidden="0"', ' hidden="false"'):
            original = mutate(self.spacers, "xl/worksheets/sheet1.xml", lambda xml: xml.replace(
                '<row r="10000">', '<row r="10000"' + old_hidden + '>'))
            for new_hidden in ('1', 'true'):
                updated = mutate(self.collapsed, "xl/worksheets/sheet1.xml", lambda xml: xml.replace(
                    '<row r="10000" hidden="1"', '<row r="10000" hidden="' + new_hidden + '"'))
                with self.subTest(before=old_hidden, after=new_hidden):
                    summary = VERIFY.assert_format_only(original, updated,
                        collapsed_rows={"xl/worksheets/sheet1.xml": [10000]})
                    self.assertEqual(summary["changed_parts"], ["xl/worksheets/sheet1.xml"])

    def test_collapsed_spacer_cannot_contain_values_inline_strings_or_formulas(self):
        payloads = ('<v>0</v>', '<v/>', '<is><t></t></is>', '<is/>',
                    '<f>SUM(1,2)</f>', '<f/>')
        for payload in payloads:
            for before_content, after_content in ((True, True), (True, False), (False, True)):
                original = mutate(self.spacers, "xl/worksheets/sheet1.xml", lambda xml: xml.replace(
                    '<c r="A10000"/>', '<c r="A10000">' + payload + '</c>')) if before_content else self.spacers
                updated = mutate(self.collapsed, "xl/worksheets/sheet1.xml", lambda xml: xml.replace(
                    '<c r="A10000"/>', '<c r="A10000">' + payload + '</c>')) if after_content else self.collapsed
                with self.subTest(payload=payload, before=before_content, after=after_content), \
                        self.assertRaisesRegex(ValueError, 'must contain no values, inline strings or formulas'):
                    VERIFY.assert_format_only(original, updated,
                        collapsed_rows={"xl/worksheets/sheet1.xml": [10000]})

    def test_collapsed_spacer_requires_visible_original_and_zero_custom_height(self):
        for attribute, replacement in (('hidden="1"', 'hidden="0"'),
                                       ('ht="0"', 'ht="15"'), ('ht="0"', ''),
                                       ('customHeight="1"', 'customHeight="0"'),
                                       ('customHeight="1"', '')):
            updated = mutate(self.collapsed, "xl/worksheets/sheet1.xml", lambda xml: xml.replace(
                '<row r="10000" hidden="1" ht="0" customHeight="1">',
                '<row r="10000" hidden="1" ht="0" customHeight="1">'.replace(attribute, replacement)))
            with self.subTest(attribute=attribute, replacement=replacement), self.assertRaises(ValueError):
                VERIFY.assert_format_only(self.spacers, updated,
                    collapsed_rows={"xl/worksheets/sheet1.xml": [10000]})
        with self.assertRaisesRegex(ValueError, 'must originally be visible'):
            VERIFY.assert_format_only(self.collapsed, self.collapsed,
                collapsed_rows={"xl/worksheets/sheet1.xml": [10000]})

    def test_spacer_allowlist_does_not_permit_other_hidden_flags_or_structural_changes(self):
        changes = {
            'other_row': lambda xml: xml.replace('<row r="10001">', '<row r="10001" hidden="1" ht="0" customHeight="1">'),
            'grouped_row': lambda xml: xml.replace('<row r="10000"', '<row r="10000" outlineLevel="1"'),
            'blank_cell_removed': lambda xml: xml.replace('<c r="A10000"/>', ''),
            'blank_cell_added': lambda xml: xml.replace('<c r="A10000"/>', '<c r="A10000"/><c r="B10000"/>'),
            'blank_cell_renamed': lambda xml: xml.replace('<c r="A10000"/>', '<c r="B10000"/>'),
            'row_removed': lambda xml: re.sub(r'<row r="10000"[^>]*>.*?</row>', '', xml),
            'row_added': lambda xml: xml.replace('</sheetData>', '<row r="10002"/></sheetData>'),
            'duplicate_row': lambda xml: xml.replace('</sheetData>', '<row r="10000"/></sheetData>'),
        }
        for name, transform in changes.items():
            with self.subTest(change=name), self.assertRaises(ValueError):
                VERIFY.assert_format_only(self.spacers,
                    mutate(self.collapsed, "xl/worksheets/sheet1.xml", transform),
                    collapsed_rows={"xl/worksheets/sheet1.xml": [10000]})

    def test_unchanged_workbook_passes(self):
        result = VERIFY.assert_format_only(self.before, self.before)
        self.assertEqual(result["changed_parts"], [])

    def test_real_formats_preserve_sanitized_and_raw_originals(self):
        for society in ("IPRS", "PRS", "ASCAP"):
            reference = ROOT / "frontend/tests/fixtures/export-formatting/references" / f"{society}.xlsx"
            for source in (ROOT / "frontend/tests/fixtures/export-formatting" / f"{society}-before.xlsx",
                           ROOT / "frontend/public" / f"{society}-verification.xlsx"):
                with self.subTest(society=society, source=source.name):
                    result, _ = FORMAT.format_workbook(society, source, reference)
                    summary = VERIFY.assert_format_only(source.read_bytes(), base64.b64decode(result))
                    self.assertEqual(set(summary["changed_parts"]),
                                     {"xl/styles.xml", "xl/worksheets/sheet1.xml"})

    def test_rejects_content_and_nonvisual_worksheet_mutations(self):
        mutations = {
            "value": lambda xml: xml.replace("<v>", "<v>9", 1),
            "formula": lambda xml: xml.replace("</sheetData>", '<row r="100"><c r="A100"><f>1+1</f></c></row></sheetData>'),
            "blank_cell": lambda xml: xml.replace("</row>", '<c r="XFD1"/></row>', 1),
            "blank_row": lambda xml: xml.replace("</sheetData>", '<row r="100"/></sheetData>'),
            "hidden_row": lambda xml: xml.replace('<row ', '<row hidden="1" ', 1),
            "hidden_column": lambda xml: xml.replace('<col ', '<col hidden="1" ', 1),
            "grouped_row": lambda xml: xml.replace('<row ', '<row outlineLevel="1" ', 1),
            "sheet_protection": lambda xml: xml.replace('</worksheet>', '<sheetProtection sheet="1"/></worksheet>'),
            "validation": lambda xml: xml.replace('</worksheet>', '<dataValidations count="1"><dataValidation sqref="A1" type="whole"/></dataValidations></worksheet>'),
            "filter": lambda xml: xml.replace('</worksheet>', '<autoFilter ref="A1:M15"/></worksheet>'),
            "invalid_style": lambda xml: xml.replace('<c ', '<c s="99999" ', 1),
        }
        for name, transform in mutations.items():
            with self.subTest(change=name), self.assertRaises(ValueError):
                VERIFY.assert_format_only(self.before, mutate(self.before, "xl/worksheets/sheet1.xml", transform))

    def test_rejects_removed_validation_even_when_values_are_identical(self):
        protected = mutate(self.before, "xl/worksheets/sheet1.xml", lambda xml: xml.replace(
            '</worksheet>', '<dataValidations count="1"><dataValidation sqref="A1" type="whole"/></dataValidations></worksheet>'))
        with self.assertRaises(ValueError):
            VERIFY.assert_format_only(protected, self.before)

    def test_rejects_formula_changes_with_identical_cached_values_and_blank_structure_removal(self):
        with_sentinels = mutate(self.before, "xl/worksheets/sheet1.xml", lambda xml: xml.replace(
            '</sheetData>', '<row r="100"><c r="A100"><f>1+1</f><v>2</v></c>'
            '<c r="B100"/></row><row r="101"/></sheetData>'))
        for before_text, after_text in (
            ('<f>1+1</f>', '<f>2*1</f>'),
            ('<c r="B100"/>', ''),
            ('<row r="101"/>', ''),
        ):
            with self.subTest(change=before_text), self.assertRaises(ValueError):
                VERIFY.assert_format_only(with_sentinels, mutate(with_sentinels,
                    "xl/worksheets/sheet1.xml", lambda xml: xml.replace(before_text, after_text)))

    def test_rejects_existing_style_and_number_format_changes(self):
        for transform in (
            lambda xml: xml.replace('numFmtId="0"', 'numFmtId="1"', 1),
            lambda xml: xml.replace('<font>', '<font><b/>', 1),
        ):
            with self.subTest(transform=transform), self.assertRaises(ValueError):
                VERIFY.assert_format_only(self.before, mutate(self.before, "xl/styles.xml", transform))

    def test_rejects_appended_nonvisual_style_assigned_to_cell_row_or_column(self):
        from xml.etree import ElementTree as ET
        with zipfile.ZipFile(io.BytesIO(self.before)) as workbook:
            style_xml = workbook.read("xl/styles.xml").decode()
        root = ET.fromstring(style_xml)
        xfs = root.find("{" + VERIFY.MAIN + "}cellXfs")
        style_id = len(xfs)
        for unsafe_style in ('<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0"/>',
                             '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf>',
                             '<xf numFmtId="0" fontId="99999" fillId="0" borderId="0" xfId="0"/>'):
            updated = mutate(self.before, "xl/styles.xml", lambda xml: xml.replace(
                f'<cellXfs count="{style_id}">', f'<cellXfs count="{style_id + 1}">').replace(
                    '</cellXfs>', unsafe_style + '</cellXfs>'))
            for element, attribute in (("c", "s"), ("row", "s"), ("col", "style")):
                def replace_style(xml):
                    def replace_tag(match):
                        tag = re.sub(rf'\s{attribute}="[^"]*"', '', match[0])
                        return tag.replace('<' + element, f'<{element} {attribute}="{style_id}"', 1)
                    return re.sub(rf'<{element}\b[^>]*>', replace_tag, xml, count=1)
                with self.subTest(element=element, style=unsafe_style), self.assertRaises(ValueError):
                    VERIFY.assert_format_only(self.before, mutate(updated, "xl/worksheets/sheet1.xml", replace_style))

    def test_rejects_nonformat_package_changes_and_reordered_members(self):
        with self.assertRaises(ValueError):
            VERIFY.assert_format_only(self.before, mutate(self.before, "xl/workbook.xml", lambda xml: xml + '\n'))
        output = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(self.before)) as source, zipfile.ZipFile(output, "w") as target:
            for info in reversed(source.infolist()):
                target.writestr(info, source.read(info.filename))
        with self.assertRaises(ValueError):
            VERIFY.assert_format_only(self.before, output.getvalue())


if __name__ == "__main__":
    unittest.main()
