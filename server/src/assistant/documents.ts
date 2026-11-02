/**
 * Documenti creati dall'assistente: il modello scrive in Markdown (titoli, testo, elenchi, tabelle)
 * e qui diventa un file Word (.docx) o PDF da scaricare. I file stanno nel database, legati all'utente.
 */
import { Lexer, type Token, type Tokens } from 'marked';
import {
  AlignmentType, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, WidthType, type ParagraphChild,
} from 'docx';
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import * as store from '../db/store.ts';
import { nowIso, uuid } from '../ids.ts';

export type DocFormat = 'pdf' | 'docx';
export interface StoredDocument { id: string; userId: string; filename: string; format: DocFormat; title: string; size: number; createdAt: string; content: string }

const BLUE = '2F5BFF';
const NAVY = '0B1D51';
const MIME: Record<DocFormat, string> = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
export const mimeOf = (f: DocFormat) => MIME[f];

/** Testo semplice di una sequenza di token inline (per il PDF e le celle). */
interface Run { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string }
function runs(tokens: Token[] | undefined, style: Omit<Run, 'text'> = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong': out.push(...runs((t as Tokens.Strong).tokens, { ...style, bold: true })); break;
      case 'em': out.push(...runs((t as Tokens.Em).tokens, { ...style, italic: true })); break;
      case 'codespan': out.push({ ...style, text: (t as Tokens.Codespan).text, code: true }); break;
      case 'link': { const href = (t as Tokens.Link).href; out.push(...runs((t as Tokens.Link).tokens, /^https?:\/\//i.test(href) ? { ...style, link: href } : style)); break; }
      case 'br': out.push({ ...style, text: '\n' }); break;
      case 'text': {
        const x = t as Tokens.Text;
        if (x.tokens?.length) out.push(...runs(x.tokens, style));
        else out.push({ ...style, text: unescape(x.text) });
        break;
      }
      case 'escape': out.push({ ...style, text: (t as Tokens.Escape).text }); break;
      default: if ('text' in t && typeof t.text === 'string') out.push({ ...style, text: unescape(t.text) });
    }
  }
  return out;
}
const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ------------------------------------------------------------------ Word

function docxRuns(rs: Run[], size?: number, color?: string): ParagraphChild[] {
  return rs.map((r) => {
    const run = new TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? 'Consolas' : undefined, size, color: r.link ? BLUE : color, underline: r.link ? {} : undefined });
    return r.link ? new ExternalHyperlink({ link: r.link, children: [run] }) : run;
  });
}

function docxBlocks(tokens: Token[], level = 0): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        const hl = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][Math.min(h.depth, 4) - 1];
        out.push(new Paragraph({ heading: hl, children: docxRuns(runs(h.tokens)) }));
        break;
      }
      case 'paragraph': out.push(new Paragraph({ spacing: { after: 120 }, children: docxRuns(runs((t as Tokens.Paragraph).tokens)) })); break;
      case 'list': {
        const l = t as Tokens.List;
        for (const item of l.items) {
          const [first, ...rest] = item.tokens;
          const text = first && (first.type === 'text' || first.type === 'paragraph') ? runs((first as Tokens.Text).tokens ?? [first]) : [];
          out.push(new Paragraph({
            children: docxRuns(text),
            ...(l.ordered ? { numbering: { reference: 'numbers', level } } : { bullet: { level } }),
          }));
          out.push(...docxBlocks(rest, level + 1));
        }
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        const cell = (c: Tokens.TableCell, head: boolean) => new TableCell({
          shading: head ? { type: ShadingType.CLEAR, fill: 'E6ECFF', color: 'auto' } : undefined,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [new Paragraph({ alignment: c.align === 'right' ? AlignmentType.RIGHT : c.align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT, children: docxRuns(runs(c.tokens).map((r) => ({ ...r, bold: r.bold || head })), 19) })],
        });
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ tableHeader: true, children: tb.header.map((c) => cell(c, true)) }), ...tb.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) }))],
        }));
        out.push(new Paragraph({ text: '' }));
        break;
      }
      case 'code':
        for (const line of (t as Tokens.Code).text.split('\n')) out.push(new Paragraph({ shading: { type: ShadingType.CLEAR, fill: 'F2F4F8', color: 'auto' }, children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })] }));
        break;
      case 'blockquote': out.push(...docxBlocks((t as Tokens.Blockquote).tokens, level)); break;
      case 'hr': out.push(new Paragraph({ border: { bottom: { color: 'C9D3EA', size: 6, style: 'single', space: 1 } }, children: [] })); break;
      case 'text': out.push(new Paragraph({ children: docxRuns(runs((t as Tokens.Text).tokens ?? [t])) })); break;
    }
  }
  return out;
}

async function toDocx(title: string, md: string): Promise<Buffer> {
  const doc = new Document({
    creator: 'Azzurro', title,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      paragraphStyles: [
        { id: 'Title', name: 'Title', run: { size: 40, bold: true, color: NAVY } },
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', run: { size: 30, bold: true, color: NAVY }, paragraph: { spacing: { before: 280, after: 120 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', run: { size: 26, bold: true, color: BLUE }, paragraph: { spacing: { before: 220, after: 100 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', run: { size: 23, bold: true, color: NAVY }, paragraph: { spacing: { before: 180, after: 80 } } },
      ],
    },
    numbering: { config: [{ reference: 'numbers', levels: [0, 1, 2].map((level) => ({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ children: [new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 240 }, children: [new TextRun(title)] }), ...docxBlocks(new Lexer().lex(md))] }],
  });
  return Packer.toBuffer(doc);
}

// ------------------------------------------------------------------ PDF

/**
 * Font: Arial di macOS incorporato (metriche giuste per €, simboli come → e ≥). Senza Arial
 * (es. Linux in Docker) si ripiega sui font standard del PDF, che coprono solo il latino occidentale:
 * shortcut: lì i simboli più comuni si traducono e gli altri diventano «?»; servirebbe un font Unicode incluso.
 */
const SYS = '/System/Library/Fonts/Supplemental/';
const ARIAL = { regular: 'Arial.ttf', bold: 'Arial Bold.ttf', italic: 'Arial Italic.ttf', boldItalic: 'Arial Bold Italic.ttf', mono: 'Courier New.ttf' };
const hasArial = Object.values(ARIAL).every((f) => existsSync(SYS + f));
const SYMBOLS: Record<string, string> = { '→': '->', '←': '<-', '⇒': '=>', '≤': '<=', '≥': '>=', '≠': '!=', '×': 'x', '✓': 'v', '✔': 'v', '✗': 'x', '−': '-', '·': '·', ' ': ' ' };
const WIN_ANSI = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const pdfText = (s: string) => hasArial ? s : [...s].map((ch) => SYMBOLS[ch] ?? (ch.charCodeAt(0) < 256 || WIN_ANSI.has(ch) ? ch : '?')).join('');

const FONT = hasArial
  ? { regular: 'A', bold: 'AB', italic: 'AI', boldItalic: 'ABI', mono: 'M' }
  : { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique', mono: 'Courier' };
const fontOf = (r: Run) => (r.bold && r.italic ? FONT.boldItalic : r.bold ? FONT.bold : r.italic ? FONT.italic : FONT.regular);

function pdfRuns(doc: PDFKit.PDFDocument, rs: Run[], opts: { size: number; color?: string; x?: number; width?: number; indent?: number } ) {
  // segmenti vicini con lo stesso stile uniti: meno cambi di stile, meno a-capo sfasati in pdfkit
  const list: Run[] = [];
  for (const r of rs) {
    const last = list.at(-1);
    if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && last.link === r.link) last.text += r.text;
    else list.push({ ...r, code: false });
  }
  if (!list.length) list.push({ text: ' ' });
  list.forEach((r, i) => {
    doc.font(fontOf(r)).fontSize(opts.size).fillColor(r.link ? `#${BLUE}` : opts.color ?? '#1d2433');
    const o: PDFKit.Mixins.TextOptions = { continued: i < list.length - 1, link: r.link, underline: !!r.link, lineGap: 2 };
    if (i === 0 && opts.width) Object.assign(o, { width: opts.width, indent: opts.indent ?? 0 });
    if (i === 0 && opts.x !== undefined) doc.text(pdfText(r.text), opts.x, doc.y, o);
    else doc.text(pdfText(r.text), o);
  });
}

function pdfTable(doc: PDFKit.PDFDocument, tb: Tokens.Table) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const cols = tb.header.length;
  // larghezze proporzionali alla lunghezza del testo, con un minimo per colonna
  const len = tb.header.map((h, c) => Math.max(runs(h.tokens).map((r) => r.text).join('').length, ...tb.rows.map((r) => (r[c] ? runs(r[c].tokens).map((x) => x.text).join('').length : 0)), 4));
  const total = len.reduce((a, b) => a + b, 0);
  const w = len.map((l) => Math.max(width * 0.08, (width * l) / total));
  const scale = width / w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cols; i++) w[i] *= scale;
  const pad = 4;
  const size = cols > 5 ? 8 : 9;
  const plain = (c: Tokens.TableCell) => runs(c.tokens).map((r) => r.text).join('');
  const rowHeight = (cells: Tokens.TableCell[], head: boolean) => Math.max(...cells.map((c, i) => {
    doc.font(head ? FONT.bold : FONT.regular).fontSize(size);
    return doc.heightOfString(pdfText(plain(c)), { width: w[i] - pad * 2 });
  })) + pad * 2;
  const drawRow = (cells: Tokens.TableCell[], head: boolean, zebra: boolean) => {
    const h = rowHeight(cells, head);
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    let x = left;
    if (head || zebra) doc.rect(left, y, width, h).fill(head ? '#E6ECFF' : '#F7F9FD');
    cells.forEach((c, i) => {
      doc.font(head ? FONT.bold : FONT.regular).fontSize(size).fillColor('#1d2433')
        .text(pdfText(plain(c)), x + pad, y + pad, { width: w[i] - pad * 2, align: c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left' });
      x += w[i];
    });
    doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.5).strokeColor('#C9D3EA').stroke();
    doc.x = left;
    doc.y = y + h;
  };
  drawRow(tb.header, true, false);
  tb.rows.forEach((r, i) => drawRow(r, false, i % 2 === 1));
  doc.moveDown(0.8);
}

function pdfBlocks(doc: PDFKit.PDFDocument, tokens: Token[], depth = 0) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        const size = [16, 13.5, 12, 11][Math.min(h.depth, 4) - 1];
        doc.moveDown(0.6);
        pdfRuns(doc, runs(h.tokens).map((r) => ({ ...r, bold: true })), { size, color: h.depth === 2 ? `#${BLUE}` : `#${NAVY}`, x: left, width });
        doc.moveDown(0.3);
        break;
      }
      case 'paragraph':
        pdfRuns(doc, runs((t as Tokens.Paragraph).tokens), { size: 10.5, x: left, width });
        doc.moveDown(0.5);
        break;
      case 'list': {
        const l = t as Tokens.List;
        l.items.forEach((item, n) => {
          const [first, ...rest] = item.tokens;
          const indent = 14 + depth * 14;
          const marker = l.ordered ? `${(Number(l.start) || 1) + n}.` : '•';
          doc.font(FONT.regular).fontSize(10.5).fillColor('#1d2433').text(marker, left + indent - 12, doc.y, { width: 12, continued: false, lineBreak: false });
          doc.moveUp();
          const text = first && (first.type === 'text' || first.type === 'paragraph') ? runs((first as Tokens.Text).tokens ?? [first]) : [];
          pdfRuns(doc, text, { size: 10.5, x: left + indent + 4, width: width - indent - 4 });
          pdfBlocks(doc, rest, depth + 1);
        });
        doc.moveDown(0.4);
        break;
      }
      case 'table': pdfTable(doc, t as Tokens.Table); break;
      case 'code':
        doc.font(FONT.mono).fontSize(8.5).fillColor('#1d2433').text(pdfText((t as Tokens.Code).text), left + 8, doc.y, { width: width - 16 });
        doc.moveDown(0.5);
        break;
      case 'blockquote': pdfBlocks(doc, (t as Tokens.Blockquote).tokens, depth); break;
      case 'hr':
        doc.moveTo(left, doc.y + 4).lineTo(left + width, doc.y + 4).lineWidth(0.5).strokeColor('#C9D3EA').stroke();
        doc.moveDown(0.8);
        break;
      case 'text': pdfRuns(doc, runs((t as Tokens.Text).tokens ?? [t]), { size: 10.5, x: left, width }); doc.moveDown(0.3); break;
    }
  }
}

function toPdf(title: string, md: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, info: { Title: pdfText(title), Creator: 'Azzurro' }, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    if (hasArial) {
      doc.registerFont('A', SYS + ARIAL.regular).registerFont('AB', SYS + ARIAL.bold).registerFont('AI', SYS + ARIAL.italic)
        .registerFont('ABI', SYS + ARIAL.boldItalic).registerFont('M', SYS + ARIAL.mono);
    }
    doc.rect(0, 0, doc.page.width, 6).fill(`#${BLUE}`);
    doc.font(FONT.bold).fontSize(20).fillColor(`#${NAVY}`).text(pdfText(title), doc.page.margins.left, 56);
    doc.font(FONT.regular).fontSize(8.5).fillColor('#6b7590').text(`Azzurro · ${new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}`);
    doc.moveDown(1);
    pdfBlocks(doc, new Lexer().lex(md));
    // numeri di pagina
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font(FONT.regular).fontSize(8).fillColor('#6b7590').text(`${i + 1} / ${range.count}`, 0, doc.page.height - 36, { width: doc.page.width - 56, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

// ------------------------------------------------------------------ archivio

/** Il titolo è già in testa al documento: se il testo ricomincia con lo stesso titolo lo si toglie. */
function body(title: string, md: string): string {
  const m = /^\s*#{1,2}\s+(.+)\n/.exec(md);
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return m && norm(m[1]) === norm(title) ? md.slice(m[0].length) : md;
}

export const renderDocument = (format: DocFormat, title: string, md: string): Promise<Buffer> => (format === 'docx' ? toDocx(title, body(title, md)) : toPdf(title, body(title, md)));

const safeName = (s: string) => s.normalize('NFKD').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'documento';

export async function createDocument(userId: string, format: DocFormat, title: string, markdown: string, filename?: string): Promise<Omit<StoredDocument, 'content'>> {
  const bytes = await renderDocument(format, title, markdown);
  if (bytes.length > 10 * 1024 * 1024) throw new Error('The document is larger than 10 MB.');
  const doc: StoredDocument = {
    id: uuid(), userId, format, title, size: bytes.length, createdAt: nowIso(),
    filename: `${safeName((filename ?? title).replace(/\.(pdf|docx)$/i, ''))}.${format}`,
    content: bytes.toString('base64'),
  };
  await store.put('assistantDocument', doc.id, doc, userId);
  const { content: _, ...meta } = doc;
  return meta;
}
