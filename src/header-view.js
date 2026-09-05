// Annotated header view: walks the schema struct the codec decoded a header
// with, slices the wire bytes per field, and renders the hex in field colours
// with a legend built from the schema's own labels and comments. Nothing here
// knows the header layout; it all comes from the JSON-LD via the codec.
//
//   const html = headerPanel(codec, header, { hash, powDetail });
//   container.innerHTML = html; attachPanel(container);

const SIZES = { u8: 1, u16le: 2, u16be: 2, u32le: 4, u32be: 4, i32le: 4, u64le: 8, i64le: 8, hash256: 32 };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hue = (i, n) => Math.round((i * 360) / n + 20) % 360;

// Which struct did the codec use for this header? Mirrors the codec's variant
// predicate (chain-scoped structVariants on btc:BlockHeader).
export function headerStruct(codec, header) {
  const variants = codec.chain?.structVariants?.['btc:BlockHeader'] ?? [];
  for (const v of variants) {
    const value = header[v.when.field];
    if (value === undefined) continue;
    const hit = v.when.bit !== undefined ? ((value >>> 0) & (2 ** v.when.bit)) !== 0 : value === v.when.equals;
    if (hit) return v.struct.replace(/^btc:/, '');
  }
  return 'BlockHeader';
}

// [{ label, wireType, offset, size, hex (wire order), value, comment }]
export function fieldLayout(codec, header) {
  const typeName = headerStruct(codec, header);
  const def = codec.def(typeName);
  const bytes = codec.encode(typeName, header);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  let offset = 0;
  const fields = def.fields.map((f) => {
    const size = f.wireType === 'bytes' ? f.wireSize : SIZES[f.wireType];
    if (size === undefined) throw new Error(`header-view: unsized wireType ${f.wireType}`);
    const out = { label: f.label, wireType: f.wireType, offset, size, hex: hex.slice(offset * 2, (offset + size) * 2), value: header[f.label], comment: f.comment ?? '' };
    offset += size;
    return out;
  });
  return { typeName, struct: def, bytes, hex, fields };
}

const fmtTime = (t) => `${t} = ${new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
function display(f, header) {
  const v = f.value;
  switch (f.label) {
    case 'version': return `0x${(v >>> 0).toString(16).padStart(8, '0')}${(v >>> 31) ? ' (bit 31 set: v2 header)' : ''}`;
    case 'time': case 'timeOnWire': return fmtTime(v);
    case 'bits': return `0x${v.toString(16)}`;
    case 'timeOffset': return `${v} s${v === 0 ? '' : ''}`;
    case 'flags': return `0b${v.toString(2).padStart(8, '0')} = ${v}: ASIC profile ${v & 3}, time offset ${(v & 4) ? 'in use' : 'not used'}${(v & 0xc0) ? ', RESERVED BITS SET' : ''}`;
    default: return f.wireType === 'hash256' ? `${v} (display order; wire bytes are reversed)` : String(v);
  }
}

export function headerPanel(codec, header, { hash, powDetail } = {}) {
  const L = fieldLayout(codec, header);
  const n = L.fields.length;
  const colour = (i) => `hsl(${hue(i, n)} 70% 50% / .32)`;
  // One span per field per 32-byte line (a field may straddle a line), so the
  // grid stays a few dozen nodes rather than one per byte.
  let hexHtml = '';
  L.fields.forEach((f, i) => {
    for (let b = f.offset; b < f.offset + f.size;) {
      const lineEnd = (Math.floor(b / 32) + 1) * 32, end = Math.min(lineEnd, f.offset + f.size);
      const run = L.hex.slice(b * 2, end * 2).match(/../g).join(' ');
      if (b === f.offset) { if (b % 32 !== 0) hexHtml += ' '; } else hexHtml += '\n';
      hexHtml += `<span class="hb" data-f="${i}" style="background:${colour(i)}" title="${esc(f.label)}: bytes ${f.offset}–${f.offset + f.size - 1}">${run}</span>`;
      b = end;
      if (b % 32 === 0 && b < L.bytes.length && b === f.offset + f.size) hexHtml += '\n';
    }
  });
  hexHtml = hexHtml.replace(/\n /g, '\n').replace(/\n\n/g, '\n');
  const rows = L.fields.map((f, i) => `<tr class="hf" data-f="${i}"><td><i style="background:${colour(i)}"></i><code>${esc(f.label)}</code></td><td>${f.offset}</td><td>${f.size}</td><td><code>${esc(f.wireType)}</code></td><td class="v"><code>${esc(display(f, header))}</code></td><td class="c">${esc(f.comment)}</td></tr>`).join('');
  const extra = [];
  if ('timeOffset' in header) extra.push(`consensus time = timeOnWire${(header.flags & 4) ? ' + timeOffset' : ''} = <code>${esc(fmtTime(header.time))}</code>`);
  const v2 = (header.version >>> 31) === 1;
  if (v2 && powDetail) {
    const d = powDetail(header);
    extra.push(`block hash = BLAKE2b-256 twice over a tagged-SHA256 commitment tree of the fields (ASIC profile ${d.asicProfile}), XOR mask ${/^0+$/.test(d.mask) ? 'all zero (no xorKey)' : '<code>' + esc(d.mask) + '</code>'}: <code>${esc(d.blockHash)}</code>${hash ? (d.blockHash === hash ? ' <span class="ok">= hash column</span>' : ' <span class="bad">≠ hash column</span>') : ''}`);
    extra.push(`intermediate: h1 <code>${esc(d.h1)}</code> · h2 <code>${esc(d.h2)}</code> · blake2b#1 <code>${esc(d.blake2b1)}</code> · blake2b#2 <code>${esc(d.blake2b2)}</code>`);
  } else if (!v2) {
    const bh = codec.blockHash(header);
    extra.push(`block hash = SHA256d of these ${L.bytes.length} bytes, displayed byte-reversed: <code>${esc(bh)}</code>${hash ? (bh === hash ? ' <span class="ok">= hash column</span>' : ' <span class="bad">≠ hash column</span>') : ''}`);
  }
  return `<div class="hpanel"><div class="hmeta"><b>${esc(L.typeName)}</b> · ${L.bytes.length} bytes · ${n} fields (from the schema struct; hover a byte or a row)</div><pre class="hhex">${hexHtml}</pre><table class="hfields"><colgroup><col class="f"><col class="o"><col class="s"><col class="w"><col class="v"><col class="c"></colgroup><thead><tr><th>field</th><th>offset</th><th>size</th><th>wire</th><th>value</th><th>schema comment</th></tr></thead><tbody>${rows}</tbody></table>${extra.map((e) => `<p class="hextra">${e}</p>`).join('')}</div>`;
}

// Hover linking between bytes and legend rows, scoped to one container.
export function attachPanel(container) {
  const mark = (i, on) => { for (const el of container.querySelectorAll(`[data-f="${i}"]`)) el.classList.toggle('hl', on); };
  container.addEventListener('mouseover', (e) => { const t = e.target.closest('[data-f]'); if (t) mark(t.dataset.f, true); });
  container.addEventListener('mouseout', (e) => { const t = e.target.closest('[data-f]'); if (t) mark(t.dataset.f, false); });
}

export const PANEL_CSS = `
.hpanel { padding: 10px 12px 6px; }
.hmeta { color: var(--mute); font-size: .88rem; margin: 0 0 8px; }
.hhex { font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 0 0 10px; white-space: pre; overflow-x: auto; }
.hhex .hb { padding: 2px 1px; border-radius: 3px; cursor: default; }
.hhex .hb.hl { outline: 2px solid var(--fg); }
.hfields { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: .86rem; }
.hfields col.f { width: 19%; } .hfields col.o { width: 6%; } .hfields col.s { width: 5%; } .hfields col.w { width: 8%; } .hfields col.v { width: 33%; }
.hfields td { overflow-wrap: anywhere; } .hfields td:first-child { overflow-wrap: normal; }
.hfields th, .hfields td { padding: 3px 8px; border-bottom: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); vertical-align: top; text-align: left; }
.hfields th, .hfields td { white-space: normal; }
.hfields tr.hl td { background: color-mix(in srgb, var(--fg) 8%, transparent); }
.hfields i { display:inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.hextra { margin: 8px 0 0; font-size: .86rem; color: var(--mute); white-space: normal; overflow-wrap: anywhere; }
tr.prow > td { padding: 0; white-space: normal; }
td.h { cursor: pointer; } td.h::after { content: ' ▸'; color: var(--mute); } tr.open td.h::after { content: ' ▾'; }
`;
