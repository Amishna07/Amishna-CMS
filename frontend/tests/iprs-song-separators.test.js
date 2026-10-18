'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const XLSX = require('../public/vendor/xlsx.full.min.js');
const JSZip = require('../public/vendor/jszip.min.js');

const dashboard = readFileSync(join(__dirname, '../public/dashboard.js'), 'utf8');
const context = { Buffer, Uint8Array, XLSX, JSZip };
context.window = context;
vm.createContext(context);
vm.runInContext(readFileSync(join(__dirname, '../public/societies.js'), 'utf8'), context);
vm.runInContext(dashboard.slice(0, dashboard.indexOf('/* iprs.js */')), context);

const attributes = xml => Object.fromEntries([...xml.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
const children = (xml, parent, child) => [...xml.match(new RegExp(`<${parent}\\b[^>]*>([\\s\\S]*?)<\\/${parent}>`))[1]
  .matchAll(new RegExp(`<${child}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${child}>)`, 'g'))].map(match => match[0]);
const isHeavy = edge => ['medium', 'thick'].includes(attributes(edge).style);

function fixture(type, contributorCounts) {
  const project = {
    id: 'separator-project', type, title: 'Separator layout', duration: '01:00:00',
    periods: [], episodes: [{ number: 2, title: 'Episode Two', duration: '00:30:00' }],
  };
  const works = contributorCounts.map((count, index) => ({
    id: 'work-' + index,
    // Equal adjacent titles must still produce two independently bordered groups.
    title: 'Repeated Song संगीत', isrc: 'IN00000000' + String(index).padStart(2, '0'),
    societies: { IPRS: '000' + index }, research: { url: 'https://example.test/' + index },
    parties: [
      { name: 'Excluded first ' + index, role: 'Composer', share: 0, society: 'PRS' },
      ...Array.from({ length: count }, (_, partyIndex) => ({
        name: 'Contributor ' + index + '/' + partyIndex,
        role: partyIndex === count - 1 && count > 1 ? 'Publisher' : 'Composer',
        share: 100 / count, ipi: '000' + index + partyIndex, society: 'IPRS/PRS',
      })),
      { name: 'Excluded last ' + index, role: 'Publisher', share: 0, society: 'ASCAP' },
    ],
  }));
  const cues = works.map((work, index) => ({ id: 'cue-' + index, workId: work.id, episode: 2, duration: 60 + index, usageCount: index + 1 }));
  // Entirely ineligible songs must not introduce phantom separators or gaps.
  works.splice(1, 0, { id: 'other-society', title: 'Excluded Song', parties: [{ name: 'PRS only', role: 'Composer', society: 'PRS', share: 100 }] });
  cues.splice(1, 0, { id: 'other-cue', workId: 'other-society', episode: 2, duration: 60 });
  return { project, cues, works, artists: [] };
}

async function exported(input) {
  const bytes = await context.CueExports.buildFormatted('IPRS', input.project, input.project.type === 'Movie' ? null : 2, input.cues, input.works, input.artists);
  const workbook = XLSX.read(bytes, { type: 'array' });
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const styles = await zip.file('xl/styles.xml').async('string');
  const xfs = children(styles, 'cellXfs', 'xf'), borders = children(styles, 'borders', 'border');
  return {
    sheet: workbook.Sheets[workbook.SheetNames[0]], xml,
    row(number) {
      const opening = xml.match(new RegExp(`<row\\b(?=[^>]*\\br="${number}")[^>]*>`))?.[0];
      assert.ok(opening, 'Original row ' + number + ' remains present');
      return attributes(opening);
    },
    edge(address, name) {
      const cell = xml.match(new RegExp(`<c\\b(?=[^>]*\\br="${address}")[^>]*>`))?.[0];
      assert.ok(cell, 'Original cell ' + address + ' remains present');
      const xf = xfs[Number(attributes(cell).s || 0)];
      const border = borders[Number(attributes(xf).borderId || 0)];
      return border.match(new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`))?.[0] || '';
    },
  };
}

const cases = [
  ['one contributor in the only song', [1]],
  ['different contributor counts and a final solo song', [2, 3, 5, 1]],
  ['24 songs beyond template capacity', Array.from({ length: 24 }, (_, index) => index === 23 ? 1 : index % 5 + 1)],
];

for (const type of ['Movie', 'Series']) {
  for (const [description, counts] of cases) {
    test(`IPRS ${type}: no visible song gaps and complete separators for ${description}`, async () => {
      const input = fixture(type, counts), snapshot = structuredClone(input);
      const output = await exported(input);
      assert.deepEqual(input, snapshot, 'Export formatting leaves all input records unchanged');
      const dataStart = type === 'Movie' ? 13 : 16;
      let row = dataStart;
      for (const [songIndex, contributorCount] of counts.entries()) {
        const firstRow = row, lastRow = row + contributorCount - 1;
        assert.equal(output.sheet['A' + firstRow].v, 'Repeated Song संगीत');
        assert.equal(output.sheet['C' + firstRow].v, songIndex + 1);
        assert.equal(output.sheet['D' + firstRow].v, '000' + songIndex, 'Song code stays at its original address');
        assert.equal(output.sheet['M' + firstRow].v, 'https://example.test/' + songIndex);
        for (; row <= lastRow; row++) {
          assert.equal(Number(output.row(row).ht), 15.75, 'Contributor row retains the approved visible height');
          assert.notEqual(output.row(row).hidden, '1', 'Contributor row remains visible');
          assert.equal(output.sheet['H' + row].v, 'Contributor ' + songIndex + '/' + (row - firstRow));
          assert.equal(output.sheet['I' + row].v, 'IPRS');
          assert.equal(output.sheet['K' + row].v, '000' + songIndex + (row - firstRow));
          for (const column of 'ABCDEFGHIJKLM') {
            const address = column + row, bottom = output.edge(address, 'bottom');
            if (row === lastRow) {
              assert.ok(isHeavy(bottom), address + ': last contributor has a strong separator');
              assert.match(bottom, /<color\b[^>]*\brgb="(?:FF)?000000"/i, address + ': separator is black');
            } else {
              assert.ok(!isHeavy(bottom), address + ': contributor grid has no premature heavy separator');
            }
            if (row > firstRow) assert.ok(!isHeavy(output.edge(address, 'top')), address + ': no heavy line within a song');
          }
        }
        const spacer = output.row(row);
        assert.equal(Number(spacer.ht), songIndex === counts.length - 1 ? 15.75 : 0, 'Only the gap before Codes is visible');
        assert.equal(spacer.customHeight, '1', 'Excel uses the collapsed spacer height');
        for (const column of 'ABCDEFGHIJKLM') assert.ok(output.sheet[column + row]?.v == null, 'Spacer contains no new data');
        row++;
      }
      assert.equal(row - dataStart, counts.reduce((sum, count) => sum + count + 1, 0), 'All original contributor and spacer rows remain in place');
      assert.equal(output.sheet['A' + row].v, 'Codes:', 'Codes follows the single blank row');
      assert.notEqual(output.row(row - 1).hidden, '1', 'The gap before Codes is visible');
      assert.notEqual(output.row(row).hidden, '1', 'Footer remains visible');
      assert.ok(!output.sheet['A' + (row - 1)], 'Gap is a plain empty row');
      const merges = output.sheet['!merges'] || [];
      assert.ok(merges.every(merge => merge.e.r < row - 2 || merge.s.r >= row - 1), 'No merged cells cross the gap');
      const names = Object.values(output.sheet).map(cell => cell?.v).filter(value => typeof value === 'string');
      assert.ok(!names.some(name => name.startsWith('Excluded') || name === 'PRS only'), 'Membership filtering is unchanged');
      const rowNumbers = [...output.xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)].map(match => Number(match[1]));
      assert.deepEqual(rowNumbers, [...new Set(rowNumbers)].sort((left, right) => left - right), 'No duplicate or reordered rows');
    });
  }
}
