// Shared styling + structural helpers for the B-Pharma LIMS CSV documentation package.
const {
  Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, Header, Footer, PageNumber, NumberFormat,
  PageBreak, TabStopType, TabStopPosition, VerticalAlign, LevelFormat, convertInchesToTwip,
} = require('docx');

const COLORS = {
  navy: '13324B',
  navyDark: '0B1F30',
  accent: '2E6F8E',
  line: 'C7D2D9',
  lineLight: 'E6ECEF',
  text: '1A2530',
  muted: '5B6B75',
  headerFill: '13324B',
  altRow: 'F2F5F7',
  warnFill: 'FBEEE0',
  warnBorder: 'D98A2B',
};

const FONT = 'Calibri';
const FONT_MONO = 'Consolas';

function docDefaults() {
  return {
    document: {
      run: { font: FONT, size: 21 }, // 10.5pt
      paragraph: { spacing: { after: 160, line: 276 } },
    },
    heading1: { run: { font: FONT, size: 30, bold: true, color: COLORS.navy }, paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
    heading2: { run: { font: FONT, size: 24, bold: true, color: COLORS.navyDark }, paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 } },
    heading3: { run: { font: FONT, size: 21, bold: true, color: COLORS.accent }, paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 } },
  };
}

function numberingConfig() {
  return {
    config: [
      {
        reference: 'bullet-list',
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 260 } } } },
          { level: 1, format: LevelFormat.BULLET, text: '\u2013', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 260 } } } },
        ],
      },
    ],
  };
}

function pageSetup() {
  return { size: { width: 12240, height: 15840 }, margin: { top: 1350, bottom: 1250, left: 1300, right: 1300 } };
}

function docHeader(docNumber, title) {
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLORS.line, space: 4 } },
        children: [
          new TextRun({ text: 'Bpharma', bold: true, color: COLORS.navy, size: 17 }),
          new TextRun({ text: '  |  B-Pharma LIMS (desktop edition)', color: COLORS.muted, size: 17 }),
          new TextRun({ text: `\t${docNumber}`, color: COLORS.muted, size: 17 }),
        ],
      }),
    ],
  });
}

function docFooter(docNumber) {
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: COLORS.line, space: 4 } },
        children: [
          new TextRun({ text: 'CONFIDENTIAL \u2014 Internal use only', italics: true, color: COLORS.muted, size: 16 }),
          new TextRun({ text: `\t${docNumber}  \u00b7  Page `, color: COLORS.muted, size: 16 }),
          new TextRun({ children: [PageNumber.CURRENT], color: COLORS.muted, size: 16 }),
          new TextRun({ text: ' of ', color: COLORS.muted, size: 16 }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], color: COLORS.muted, size: 16 }),
        ],
      }),
    ],
  });
}

function titleBlock({ docType, docTypeFull, docNumber, title, version, effectiveDate, system }) {
  const cell = (label, value, opts = {}) => new TableCell({
    width: { size: opts.w || 2500, type: WidthType.DXA },
    shading: opts.shade ? { type: ShadingType.CLEAR, fill: COLORS.lineLight } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({ children: [
      new TextRun({ text: label, bold: true, size: 16, color: COLORS.muted }),
    ] }), new Paragraph({ children: [new TextRun({ text: value, size: 19 })] })],
  });

  return [
    new Paragraph({
      spacing: { before: 0, after: 60 },
      children: [new TextRun({ text: 'Bpharma', bold: true, size: 20, color: COLORS.muted })],
    }),
    new Paragraph({
      spacing: { before: 0, after: 60 },
      children: [new TextRun({ text: 'Advanced Pharmaceutical Industries Co. Ltd \u00b7 Jeddah, Kingdom of Saudi Arabia', size: 17, color: COLORS.muted })],
    }),
    new Paragraph({ spacing: { before: 400, after: 60 }, children: [
      new TextRun({ text: docTypeFull, size: 20, color: COLORS.accent, bold: true }),
    ] }),
    new Paragraph({ heading: HeadingLevel.TITLE, spacing: { before: 0, after: 300 }, children: [
      new TextRun({ text: title, bold: true, size: 44, color: COLORS.navy }),
    ] }),
    new Table({
      width: { size: 10000, type: WidthType.DXA },
      columnWidths: [2500, 2500, 2500, 2500],
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
        left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      },
      rows: [
        new TableRow({ children: [cell('Document Number', docNumber, { shade: true }), cell('Document Type', docType), cell('Version', version, { shade: true }), cell('Effective Date', effectiveDate)] }),
        new TableRow({ children: [cell('System', system, { shade: true, w: 10000 * 0.7 }), cell('GAMP Category', 'Category 5 \u2014 Custom Application', {})] }),
      ],
    }),
    new Paragraph({ spacing: { before: 500, after: 0 }, children: [new PageBreak()] }),
  ];
}

function approvalTable() {
  const headerCell = (t) => new TableCell({
    shading: { type: ShadingType.CLEAR, fill: COLORS.headerFill },
    verticalAlign: VerticalAlign.CENTER, margins: { top: 90, bottom: 90, left: 110, right: 110 },
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: 'FFFFFF', size: 18 })] })],
  });
  const cell = (w) => new TableCell({ width: { size: w, type: WidthType.DXA }, margins: { top: 260, bottom: 90, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text: '', size: 18 })] })] });
  const row = (role) => new TableRow({ children: [
    new TableCell({ width: { size: 2400, type: WidthType.DXA }, margins: { top: 90, bottom: 90, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text: role, bold: true, size: 18 })] })] }),
    cell(2530), cell(2530), cell(2540),
  ] });
  return new Table({
    width: { size: 10000, type: WidthType.DXA },
    columnWidths: [2400, 2530, 2530, 2540],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
    },
    rows: [
      new TableRow({ children: [new TableCell({ width: { size: 2400, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: 'Role', bold: true, color: 'FFFFFF', size: 18 })] })], shading: { type: ShadingType.CLEAR, fill: COLORS.headerFill } }), headerCell('Name / Title'), headerCell('Signature'), headerCell('Date')] }),
      row('Prepared by (Validation)'),
      row('Reviewed by (System Owner)'),
      row('Reviewed by (QA)'),
      row('Approved by (QA Head)'),
    ],
  });
}

function p(text, opts = {}) {
  return new Paragraph({
    spacing: opts.spacing || { after: 160 },
    children: [new TextRun({ text, size: opts.size || 21, bold: !!opts.bold, italics: !!opts.italics, color: opts.color || COLORS.text })],
  });
}

function bullets(items, opts = {}) {
  return items.map(t => new Paragraph({
    numbering: { reference: 'bullet-list', level: opts.level || 0 },
    spacing: { after: 90 },
    children: [new TextRun({ text: t, size: opts.size || 21 })],
  }));
}

function h1(text) { return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text })] }); }
function h2(text) { return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text })] }); }
function h3(text) { return new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text })] }); }

function simpleTable(headerRow, dataRows, colWidths) {
  const total = colWidths.reduce((a, b) => a + b, 0);
  const headerCells = headerRow.map((t, i) => new TableCell({
    width: { size: colWidths[i], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: COLORS.headerFill },
    verticalAlign: VerticalAlign.CENTER, margins: { top: 90, bottom: 90, left: 110, right: 110 },
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: 'FFFFFF', size: 17 })] })],
  }));
  const rows = [new TableRow({ children: headerCells, tableHeader: true })];
  dataRows.forEach((r, ri) => {
    const shaded = ri % 2 === 1;
    rows.push(new TableRow({
      children: r.map((val, i) => new TableCell({
        width: { size: colWidths[i], type: WidthType.DXA },
        shading: shaded ? { type: ShadingType.CLEAR, fill: COLORS.altRow } : undefined,
        margins: { top: 70, bottom: 70, left: 110, right: 110 },
        children: (Array.isArray(val) ? val : [val]).map(v => typeof v === 'string'
          ? new Paragraph({ children: [new TextRun({ text: v, size: 17 })] })
          : v),
      })),
    }));
  });
  return new Table({
    width: { size: total, type: WidthType.DXA }, columnWidths: colWidths,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
    },
    rows,
  });
}

function calloutBox(text, opts = {}) {
  return new Table({
    width: { size: 10000, type: WidthType.DXA }, columnWidths: [10000],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.warnBorder }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.warnBorder },
      left: { style: BorderStyle.SINGLE, size: 16, color: COLORS.warnBorder }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.warnBorder },
    },
    rows: [new TableRow({ children: [new TableCell({
      shading: { type: ShadingType.CLEAR, fill: COLORS.warnFill }, width: { size: 10000, type: WidthType.DXA },
      margins: { top: 140, bottom: 140, left: 200, right: 200 },
      children: [new Paragraph({ children: [new TextRun({ text: opts.label || 'Note', bold: true, size: 18, color: COLORS.warnBorder })] }),
                 new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text, size: 19 })] })],
    })] })],
  });
}

function reqTable(rows) {
  // rows: [[id, text, priority], ...]
  const priColor = (p) => p === 'Critical' ? 'B3261E' : (p === 'High' ? 'B45309' : '2E6F8E');
  const headerCells = ['ID', 'Requirement', 'Priority'].map((t, i) => new TableCell({
    width: { size: [1100, 7200, 1700][i], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: COLORS.headerFill },
    verticalAlign: VerticalAlign.CENTER, margins: { top: 90, bottom: 90, left: 110, right: 110 },
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: 'FFFFFF', size: 17 })] })],
  }));
  const trs = [new TableRow({ children: headerCells, tableHeader: true })];
  rows.forEach(([id, text, pri], ri) => {
    const shaded = ri % 2 === 1;
    trs.push(new TableRow({ children: [
      new TableCell({ width: { size: 1100, type: WidthType.DXA }, shading: shaded ? { type: ShadingType.CLEAR, fill: COLORS.altRow } : undefined, margins: { top: 70, bottom: 70, left: 110, right: 110 }, verticalAlign: VerticalAlign.CENTER, children: [new Paragraph({ children: [new TextRun({ text: id, bold: true, size: 17, color: COLORS.navy })] })] }),
      new TableCell({ width: { size: 7200, type: WidthType.DXA }, shading: shaded ? { type: ShadingType.CLEAR, fill: COLORS.altRow } : undefined, margins: { top: 70, bottom: 70, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text, size: 18 })] })] }),
      new TableCell({ width: { size: 1700, type: WidthType.DXA }, shading: shaded ? { type: ShadingType.CLEAR, fill: COLORS.altRow } : undefined, verticalAlign: VerticalAlign.CENTER, margins: { top: 70, bottom: 70, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text: pri, bold: true, size: 17, color: priColor(pri) })] })] }),
    ] }));
  });
  return new Table({
    width: { size: 10000, type: WidthType.DXA }, columnWidths: [1100, 7200, 1700],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
    },
    rows: trs,
  });
}

function testCaseHeader(id, objective, prereq) {
  const rows = [
    new TableRow({ children: [
      new TableCell({ width: { size: 2000, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: COLORS.headerFill }, verticalAlign: VerticalAlign.CENTER, margins: { top: 80, bottom: 80, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text: 'Test Case ID', bold: true, color: 'FFFFFF', size: 17 })] })] }),
      new TableCell({ width: { size: 8000, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER, margins: { top: 80, bottom: 80, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text: id, bold: true, size: 19, color: COLORS.navy })] })] }),
    ] }),
    new TableRow({ children: [
      new TableCell({ shading: { type: ShadingType.CLEAR, fill: COLORS.headerFill }, verticalAlign: VerticalAlign.CENTER, margins: { top: 80, bottom: 80, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text: 'Objective', bold: true, color: 'FFFFFF', size: 17 })] })] }),
      new TableCell({ margins: { top: 80, bottom: 80, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text: objective, size: 18 })] })] }),
    ] }),
    new TableRow({ children: [
      new TableCell({ shading: { type: ShadingType.CLEAR, fill: COLORS.headerFill }, verticalAlign: VerticalAlign.CENTER, margins: { top: 80, bottom: 80, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text: 'Prerequisites', bold: true, color: 'FFFFFF', size: 17 })] })] }),
      new TableCell({ margins: { top: 80, bottom: 80, left: 110, right: 110 }, children: [new Paragraph({ children: [new TextRun({ text: prereq, size: 18 })] })] }),
    ] }),
  ];
  return new Table({
    width: { size: 10000, type: WidthType.DXA }, columnWidths: [2000, 8000],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
    },
    rows,
  });
}

function testSteps(rows) {
  const headerCells = ['Step', 'Action', 'Expected Result', 'Actual Result', 'P/F'].map((t, i) => new TableCell({
    width: { size: [600, 3500, 3900, 1500, 500][i], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: COLORS.navyDark },
    verticalAlign: VerticalAlign.CENTER, margins: { top: 80, bottom: 80, left: 90, right: 90 },
    children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: 'FFFFFF', size: 16 })] })],
  }));
  const trs = [new TableRow({ children: headerCells, tableHeader: true })];
  rows.forEach(([step, action, expected, actual, pf], ri) => {
    const shaded = ri % 2 === 1;
    const pfColor = pf === 'P' ? '177245' : (pf === 'F' ? 'B3261E' : undefined);
    const c = (w, content, opts = {}) => new TableCell({
      width: { size: w, type: WidthType.DXA }, shading: shaded ? { type: ShadingType.CLEAR, fill: COLORS.altRow } : undefined,
      margins: { top: 70, bottom: 70, left: 90, right: 90 }, verticalAlign: opts.center ? VerticalAlign.CENTER : undefined,
      children: [new Paragraph({ children: [new TextRun({ text: content, size: 17, bold: !!opts.bold, color: opts.color })] })],
    });
    trs.push(new TableRow({ children: [
      c(600, String(step), { center: true, bold: true }),
      c(3500, action), c(3900, expected),
      c(1500, actual || '', { center: false }),
      c(500, pf || '', { center: true, bold: true, color: pfColor }),
    ] }));
  });
  return new Table({
    width: { size: 10000, type: WidthType.DXA }, columnWidths: [600, 3500, 3900, 1500, 500],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
    },
    rows: trs,
  });
}

function execSignoffFilled(executor, execDate, reviewer, reviewDate) {
  const cell = (label, value, w) => new TableCell({
    width: { size: w, type: WidthType.DXA }, margins: { top: 130, bottom: 80, left: 110, right: 110 },
    children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 16, color: COLORS.muted })] }),
               new Paragraph({ children: [new TextRun({ text: value || '', size: 18 })] })],
  });
  return new Table({
    width: { size: 10000, type: WidthType.DXA }, columnWidths: [2500, 2500, 2500, 2500],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
    },
    rows: [new TableRow({ children: [
      cell('Executed by (Name/Signature)', executor, 2500), cell('Date', execDate, 2500),
      cell('Reviewed by (QA)', reviewer, 2500), cell('Date', reviewDate, 2500),
    ] })],
  });
}

function execSignoff() {
  const cell = (label, w) => new TableCell({
    width: { size: w, type: WidthType.DXA }, margins: { top: 260, bottom: 80, left: 110, right: 110 },
    children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 16, color: COLORS.muted })] }), new Paragraph({ children: [new TextRun({ text: '', size: 18 })] })],
  });
  return new Table({
    width: { size: 10000, type: WidthType.DXA }, columnWidths: [2500, 2500, 2500, 2500],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: COLORS.line },
    },
    rows: [new TableRow({ children: [cell('Executed by (Name/Signature)', 2500), cell('Date', 2500), cell('Reviewed by (QA)', 2500), cell('Date', 2500)] })],
  });
}

module.exports = {
  Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, Header, Footer, PageNumber, NumberFormat, PageBreak,
  TabStopType, TabStopPosition, VerticalAlign, convertInchesToTwip,
  COLORS, FONT, FONT_MONO, docDefaults, numberingConfig, pageSetup, docHeader, docFooter,
  titleBlock, approvalTable, p, bullets, h1, h2, h3, simpleTable, calloutBox, reqTable,
  testCaseHeader, testSteps, execSignoff, execSignoffFilled,
};
