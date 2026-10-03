import { describe, expect, it } from 'vitest';
import { zipFiles } from '../../zip';
import { XlsxError, looksLikeXlsx, readXlsxRows } from '..';

/**
 * 26 Sep 2026 — the first worksheet of an .xlsx as rows of cells, the shape
 * `parseCsv` answers. The workbooks here are built part by part the way
 * Excel writes them (a relationship to the sheet, shared strings with a
 * rich run and a phonetic hint, an inline string, a skipped cell, a date
 * style, a boolean, a formula's cached value, an error, trailing blank rows).
 */

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Spots" sheetId="1" r:id="rId3"/><sheet name="Notes" sheetId="2" r:id="rId4"/></sheets>
</workbook>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet7.xml"/>
</Relationships>`;

const SHARED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5">
  <si><t>title</t></si>
  <si><t>category</t></si>
  <si><t>ratePerDay</t></si>
  <si><r><t>MG Road </t></r><r><rPr><b/></rPr><t>Hoarding</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si>
  <si><t xml:space="preserve">outdoor &amp; lit</t></si>
</sst>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
  <cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs>
</styleSheet>`;

const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>availableFrom</t></is></c><c r="E1" t="inlineStr"><is><t>instantBooking</t></is></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>1234.5600000000001</v></c><c r="D2" s="1"><v>46291</v></c><c r="E2" t="b"><v>1</v></c></row>
    <row r="4"><c r="A4" t="str"><f>A2&amp;"!"</f><v>MG Road Hoarding!</v></c><c r="C4" t="e"><v>#DIV/0!</v></c><c r="D4" s="2"><v>46292.5</v></c></row>
    <row r="5"><c r="A5" s="1"/></row>
    <row r="6"/>
  </sheetData>
</worksheet>`;

const OTHER_SHEET = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong sheet</t></is></c></row></sheetData></worksheet>`;

function workbook(parts: Record<string, string>): Buffer {
  return zipFiles(Object.entries(parts).map(([name, data]) => ({ name, data })));
}

const full = () =>
  workbook({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': WORKBOOK,
    'xl/_rels/workbook.xml.rels': RELS,
    'xl/sharedStrings.xml': SHARED,
    'xl/styles.xml': STYLES,
    'xl/worksheets/sheet7.xml': SHEET,
    'xl/worksheets/sheet2.xml': OTHER_SHEET,
  });

describe('readXlsxRows', () => {
  it('reads the first sheet in the workbook order, through its relationship', () => {
    const rows = readXlsxRows(full());
    expect(rows[0]).toEqual(['title', 'category', 'ratePerDay', 'availableFrom', 'instantBooking']);
  });

  it('turns each kind of cell into the text a CSV would carry', () => {
    const rows = readXlsxRows(full());
    // Rich runs joined, the phonetic hint left out; entities decoded; the float at its shortest; a date style as an ISO date; a boolean.
    expect(rows[1]).toEqual(['MG Road Hoarding', 'outdoor & lit', '1234.56', '2026-09-26', 'TRUE']);
    // The row the sheet skipped is an empty row, so row numbers keep their meaning.
    expect(rows[2]).toEqual([]);
    // A formula's cached value; a skipped cell empty; an error empty; a custom date code a date.
    expect(rows[3]).toEqual(['MG Road Hoarding!', '', '', '2026-09-27']);
    // Trailing blank rows are not data.
    expect(rows).toHaveLength(4);
  });

  it('falls back to sheet1 when the workbook carries no relationships', () => {
    const rows = readXlsxRows(workbook({ 'xl/workbook.xml': '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>', 'xl/worksheets/sheet1.xml': OTHER_SHEET }));
    expect(rows).toEqual([['wrong sheet']]);
  });

  it('refuses what is not a workbook', () => {
    expect(() => readXlsxRows(Buffer.from('title,category\nA,OUTDOOR\n'))).toThrow(XlsxError);
    expect(() => readXlsxRows(workbook({ 'readme.txt': 'hello' }))).toThrow(XlsxError);
    expect(() => readXlsxRows(workbook({ 'xl/workbook.xml': WORKBOOK }))).toThrow(XlsxError);
  });

  it('tells a workbook from a CSV by its first bytes', () => {
    expect(looksLikeXlsx(full())).toBe(true);
    expect(looksLikeXlsx(Buffer.from('title,category\n'))).toBe(false);
  });
});
