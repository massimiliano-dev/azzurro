import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { renderDocument } from '../../src/assistant/documents.ts';

const MD = `# Costi di ottobre

Spesa **totale**: 1.180 € → in calo rispetto a settembre.

- Web app: 25 €
- Database: 53 €
  1. compute
  2. storage

| Risorsa | Piano | Costo |
|---|---|--:|
| cantieros | P1v3 | 120,50 € |
| cantierosplsql | B2s | 53 € |

\`\`\`
az group list
\`\`\`
`;

/** document.xml dentro il .docx (zip): basta leggere la voce compressa con deflate. */
function docxXml(buf: Buffer): string {
  const name = Buffer.from('word/document.xml');
  const at = buf.indexOf(name);
  assert.ok(at > 30, 'word/document.xml nello zip');
  const h = at - 30;
  const size = buf.readUInt32LE(h + 18);
  const extra = buf.readUInt16LE(h + 28);
  const data = buf.subarray(at + name.length + extra, at + name.length + extra + size);
  return buf.readUInt16LE(h + 8) === 8 ? inflateRawSync(data).toString('utf8') : data.toString('utf8');
}

test('Word: titolo, tabella, elenchi e simboli', async () => {
  const buf = await renderDocument('docx', 'Report costi', MD);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const xml = docxXml(buf);
  for (const s of ['Report costi', 'Costi di ottobre', 'cantierosplsql', '120,50 €', '→', 'az group list']) assert.ok(xml.includes(s), s);
  assert.ok(xml.includes('<w:tbl>'), 'tabella');
  assert.ok(xml.includes('<w:numPr>'), 'elenchi');
});

test('niente titolo ripetuto, link del portale come testo', async () => {
  const xml = docxXml(await renderDocument('docx', 'Report costi', '# Report costi\n\n| Gruppo |\n|---|\n| [demo-rg](/resource-groups/x/demo-rg) |\n'));
  assert.equal(xml.split('Report costi').length - 1, 1, 'titolo una volta sola');
  assert.ok(xml.includes('demo-rg') && !xml.includes('/resource-groups/'), 'link interno come testo');
});

test('PDF: valido, testo con € e simboli fuori WinAnsi', async () => {
  const buf = await renderDocument('pdf', 'Report costi', MD);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 1500);
  assert.ok(buf.subarray(-8).toString().includes('%%EOF'));
});
