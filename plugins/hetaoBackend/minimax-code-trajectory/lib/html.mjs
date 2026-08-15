import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function writeTrajectoryHtml({ trajectory, outputDir }) {
  const dataRoot = path.resolve(outputDir);
  await ensurePhysicalDirectory(dataRoot);
  const root = path.join(dataRoot, 'trajectory-html');
  await ensurePhysicalDirectory(root);
  const sessionId = String(trajectory?.session?.sessionId ?? 'session');
  const fingerprint = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  const fileName = `${safeFilePart(sessionId)}-${fingerprint}.html`;
  const filePath = path.join(root, fileName);
  const temporaryPath = path.join(root, `.${fileName}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, renderTrajectoryHtml(trajectory), { encoding: 'utf8', mode: 0o600 });
    await rm(filePath, { force: true });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { fileUrl: pathToFileURL(filePath).href };
}

export function renderTrajectoryHtml(trajectory) {
  const data = safeJson(trajectory);
  const session = trajectory?.session ?? {};
  const summary = trajectory?.summary ?? {};
  const privacy = trajectory?.privacy ?? {};
  const events = Array.isArray(trajectory?.events) ? trajectory.events : [];
  const warnings = Array.isArray(trajectory?.warnings) ? trajectory.warnings : [];
  const firstAt = finiteNumber(summary.firstEventAtMs, events[0]?.createdAtMs ?? 0);
  const kinds = [...new Set(events.map((event) => String(event?.kind ?? 'unknown')))];
  const maxDelta = Math.max(
    1,
    ...events.map((event, index) => {
      const previous = events[index - 1];
      return index === 0 ? 0 : Math.max(0, finiteNumber(event?.createdAtMs, 0) - finiteNumber(previous?.createdAtMs, 0));
    }),
  );
  const filters = ['all', ...kinds].map((kind, index) => `
      <button class="filter" type="button" data-filter="${escapeAttr(kind)}" aria-pressed="${index === 0 ? 'true' : 'false'}">
        ${escapeHtml(kind === 'all' ? 'All events' : shortKind(kind))}
      </button>`).join('');
  const eventRows = events.map((event, index) => {
    const kind = String(event?.kind ?? 'unknown');
    const previousAt = finiteNumber(events[index - 1]?.createdAtMs, firstAt);
    const createdAt = finiteNumber(event?.createdAtMs, firstAt);
    const delta = index === 0 ? 0 : Math.max(0, createdAt - previousAt);
    const pulse = delta === 0 ? 8 : Math.max(12, Math.round((Math.log1p(delta) / Math.log1p(maxDelta)) * 100));
    return `
      <button class="event-card tone-${eventTone(kind)}" type="button" role="listitem"
        data-event-index="${index}" data-kind="${escapeAttr(kind)}" aria-current="${index === 0 ? 'true' : 'false'}">
        <span class="event-node" aria-hidden="true"></span>
        <span class="event-time">
          <strong>+${escapeHtml(formatDuration(Math.max(0, createdAt - firstAt)))}</strong>
          <small>${escapeHtml(formatDuration(delta))} delta</small>
        </span>
        <span class="event-copy">
          <strong>${escapeHtml(shortKind(kind))}</strong>
          <small>${escapeHtml(eventSubtitle(event))}</small>
        </span>
        <span class="pulse" style="--pulse:${pulse}%" aria-label="Relative time gap ${escapeAttr(formatDuration(delta))}"><i></i></span>
        <span class="event-seq">#${escapeHtml(String(event?.seq ?? index + 1))}</span>
      </button>`;
  }).join('');
  const warningMarkup = warnings.length > 0
    ? `<div class="warning" role="status"><strong>Read with caution.</strong> ${escapeHtml(warnings.join(' · '))}</div>`
    : '<div class="clean" role="status"><span></span> Ledger parsed without warnings</div>';
  const initial = events[0] ?? {};
  const sessionId = String(session.sessionId ?? 'Unknown session');
  const status = String(session.status ?? 'recorded');
  const detailLevel = String(privacy.detailLevel ?? 'summary');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>MiniMax Code trajectory · ${escapeHtml(sessionId)}</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #f1f3f0; --paper-deep: #e7ebe7; --panel: #fbfcfa; --ink: #18202b;
      --muted: #637078; --faint: #8b969b; --rule: #cfd7d1; --grid: rgba(83, 104, 92, .09);
      --signal: #d86f2d; --signal-soft: #f6e3d5; --teal: #147d68; --teal-soft: #d9ece6;
      --red: #bd4747; --blue: #426b8b; --shadow: rgba(24, 32, 43, .10);
      --ease: cubic-bezier(.22, 1, .36, 1);
    }
    * { box-sizing: border-box; }
    html { min-width: 320px; background: var(--paper); }
    body {
      margin: 0; min-height: 100dvh; color: var(--ink);
      font-family: Aptos, 'Segoe UI', sans-serif; line-height: 1.55; text-wrap: pretty;
      background-color: var(--paper);
      background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
      background-size: 24px 24px;
    }
    button { font: inherit; }
    .shell { width: min(1440px, 100%); margin: 0 auto; padding: 30px clamp(16px, 3vw, 44px) 56px; }
    .masthead { border-top: 5px solid var(--ink); padding-top: 18px; }
    .eyebrow { display: flex; align-items: center; gap: 10px; margin: 0 0 8px; color: var(--muted); font: 700 11px/1.2 'Cascadia Mono', ui-monospace, monospace; letter-spacing: .15em; text-transform: uppercase; }
    .eyebrow::before { content: ''; width: 30px; height: 2px; background: var(--signal); }
    .headline-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
    h1 { margin: 0; max-width: 900px; font: 700 clamp(30px, 5vw, 68px)/.98 'DIN Alternate', Bahnschrift, sans-serif; letter-spacing: -.025em; overflow-wrap: anywhere; }
    .status { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--rule); border-radius: 999px; padding: 8px 12px; background: rgba(251,252,250,.75); color: var(--muted); font: 700 11px/1 'Cascadia Mono', ui-monospace, monospace; text-transform: uppercase; }
    .status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--teal); box-shadow: 0 0 0 4px var(--teal-soft); }
    .session-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 16px 0 0; color: var(--muted); font: 12px/1.4 'Cascadia Mono', ui-monospace, monospace; }
    .metrics { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1px; margin: 26px 0 0; overflow: hidden; border: 1px solid var(--rule); border-radius: 14px; background: var(--rule); box-shadow: 0 14px 40px var(--shadow); }
    .metric { min-height: 88px; padding: 16px; background: rgba(251,252,250,.94); }
    .metric strong { display: block; font: 700 clamp(20px, 2.5vw, 30px)/1 'DIN Alternate', Bahnschrift, sans-serif; }
    .metric span { display: block; margin-top: 9px; color: var(--muted); font: 700 10px/1.2 'Cascadia Mono', ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
    .warning, .clean { margin-top: 14px; border-radius: 10px; padding: 11px 14px; font-size: 13px; }
    .warning { background: #f8e6e1; color: #843b37; border: 1px solid #e7b9ae; }
    .clean { display: flex; align-items: center; gap: 9px; color: var(--teal); }
    .clean span { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .workspace { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(300px, .75fr); gap: 18px; margin-top: 20px; align-items: start; }
    .panel { border: 1px solid var(--rule); border-radius: 16px; background: rgba(251,252,250,.94); box-shadow: 0 14px 40px var(--shadow); overflow: hidden; }
    .toolbar { padding: 16px; border-bottom: 1px solid var(--rule); }
    .toolbar-top { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    h2 { margin: 0; font: 700 18px/1.2 'DIN Alternate', Bahnschrift, sans-serif; letter-spacing: .01em; }
    .toolbar-note { color: var(--muted); font: 11px/1.3 'Cascadia Mono', ui-monospace, monospace; }
    .filters { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
    .filter { min-height: 36px; border: 1px solid var(--rule); border-radius: 999px; padding: 7px 11px; background: var(--panel); color: var(--muted); cursor: pointer; font: 700 10px/1 'Cascadia Mono', ui-monospace, monospace; transition: transform .2s var(--ease), border-color .2s, color .2s, background .2s; }
    .filter:hover { border-color: var(--ink); color: var(--ink); transform: translateY(-1px); }
    .filter[aria-pressed="true"] { border-color: var(--ink); color: var(--panel); background: var(--ink); }
    .filter:focus-visible, .event-card:focus-visible { outline: 3px solid rgba(216,111,45,.35); outline-offset: 2px; }
    .timeline { position: relative; padding: 8px 14px 18px 20px; }
    .timeline::before { content: ''; position: absolute; top: 24px; bottom: 32px; left: 34px; width: 1px; background: var(--rule); }
    .event-card { position: relative; display: grid; grid-template-columns: 16px 86px minmax(150px,1fr) minmax(70px,.55fr) 40px; gap: 12px; align-items: center; width: 100%; min-height: 70px; border: 0; border-bottom: 1px solid var(--paper-deep); padding: 10px 8px 10px 0; color: inherit; text-align: left; background: transparent; cursor: pointer; transition: transform .25s var(--ease), background .2s; }
    .event-card:hover { background: rgba(231,235,231,.55); transform: translateX(3px); }
    .event-card[aria-current="true"] { background: var(--signal-soft); }
    .event-card[hidden] { display: none; }
    .event-node { position: relative; z-index: 1; width: 11px; height: 11px; margin-left: 9px; border: 3px solid var(--panel); border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 1px var(--blue); }
    .tone-session .event-node { background: var(--teal); box-shadow: 0 0 0 1px var(--teal); }
    .tone-message .event-node { background: var(--signal); box-shadow: 0 0 0 1px var(--signal); }
    .tone-state .event-node { background: var(--red); box-shadow: 0 0 0 1px var(--red); }
    .event-time strong, .event-time small, .event-copy small { display: block; }
    .event-time strong { font: 700 12px/1.2 'Cascadia Mono', ui-monospace, monospace; }
    .event-time small, .event-copy small { margin-top: 5px; color: var(--faint); font-size: 10px; }
    .event-copy strong { font-size: 13px; overflow-wrap: anywhere; }
    .pulse { display: block; height: 5px; border-radius: 999px; background: var(--paper-deep); overflow: hidden; }
    .pulse i { display: block; width: var(--pulse); height: 100%; border-radius: inherit; background: var(--signal); }
    .event-seq { color: var(--faint); text-align: right; font: 10px/1 'Cascadia Mono', ui-monospace, monospace; }
    .empty { display: none; padding: 36px; color: var(--muted); text-align: center; }
    .inspector { position: sticky; top: 18px; }
    .inspector-head { padding: 18px; border-bottom: 1px solid var(--rule); background: var(--ink); color: var(--panel); }
    .inspector-head p { margin: 7px 0 0; color: #bfc8ca; font: 11px/1.4 'Cascadia Mono', ui-monospace, monospace; }
    .inspector-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--rule); border-bottom: 1px solid var(--rule); }
    .inspector-stat { padding: 12px 15px; background: var(--panel); }
    .inspector-stat span, .inspector-stat strong { display: block; }
    .inspector-stat span { color: var(--faint); font: 9px/1.2 'Cascadia Mono', ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
    .inspector-stat strong { margin-top: 6px; font-size: 12px; overflow-wrap: anywhere; }
    pre { max-height: 54vh; margin: 0; padding: 16px; overflow: auto; color: #26343e; background: var(--panel); font: 11px/1.65 'Cascadia Mono', ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .footer { margin-top: 18px; color: var(--muted); font: 10px/1.6 'Cascadia Mono', ui-monospace, monospace; }
    @media (max-width: 980px) { .metrics { grid-template-columns: repeat(3, 1fr); } .workspace { grid-template-columns: 1fr; } .inspector { position: static; } }
    @media (max-width: 620px) { .shell { padding-inline: 12px; } .headline-row { align-items: flex-start; flex-direction: column; } .metrics { grid-template-columns: repeat(2, 1fr); } .event-card { grid-template-columns: 16px 72px 1fr 34px; gap: 8px; } .pulse { display: none; } .toolbar-top { align-items: flex-start; flex-direction: column; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="masthead">
      <p class="eyebrow">MiniMax Code · Agent flight recorder</p>
      <div class="headline-row">
        <h1>${escapeHtml(sessionId)}</h1>
        <span class="status">${escapeHtml(status)}</span>
      </div>
      <div class="session-meta">
        <span>${escapeHtml(String(session.agentName ?? 'agent'))}</span>
        <span>${escapeHtml(String(session.runtime ?? 'runtime unknown'))}</span>
        <span>${escapeHtml(detailLevel)} detail</span>
        <span>${events.length} rendered / ${escapeHtml(String(summary.totalRecords ?? events.length))} records</span>
      </div>
      <section class="metrics" aria-label="Trajectory summary">
        ${metric(summary.totalRecords ?? 0, 'Ledger records')}
        ${metric(formatDuration(summary.durationMs ?? 0), 'Elapsed')}
        ${metric(summary.piToolCallCount ?? 0, 'Pi tool calls')}
        ${metric(formatNumber(summary.piUsageTotalTokens ?? 0), 'Pi tokens')}
        ${metric(summary.compactionCount ?? 0, 'Compactions')}
        ${metric(warnings.length, 'Warnings')}
      </section>
      ${warningMarkup}
    </header>

    <main class="workspace">
      <section class="panel" aria-labelledby="timeline-heading">
        <div class="toolbar">
          <div class="toolbar-top">
            <h2 id="timeline-heading">Event timeline</h2>
            <span class="toolbar-note">Select an event to inspect · pulse width = time gap</span>
          </div>
          <div class="filters" aria-label="Filter trajectory events">${filters}</div>
        </div>
        <div class="timeline" id="timeline" role="list">${eventRows}</div>
        <div class="empty" id="empty-state">No events match this filter.</div>
      </section>

      <aside class="panel inspector" id="event-inspector" aria-live="polite">
        <div class="inspector-head">
          <h2 id="inspector-kind">${escapeHtml(String(initial.kind ?? 'No event selected'))}</h2>
          <p id="inspector-time">${escapeHtml(formatTimestamp(initial.createdAtMs))}</p>
        </div>
        <div class="inspector-grid">
          <div class="inspector-stat"><span>Sequence</span><strong id="inspector-seq">${escapeHtml(String(initial.seq ?? '—'))}</strong></div>
          <div class="inspector-stat"><span>Event ID</span><strong id="inspector-id">${escapeHtml(String(initial.eventId ?? '—'))}</strong></div>
        </div>
        <pre id="inspector-json">${escapeHtml(JSON.stringify(initial, null, 2))}</pre>
      </aside>
    </main>
    <footer class="footer">Generated locally from the MiniMax Code v2 ledger. No network requests, telemetry, raw records, tool arguments, tool results, or thinking are added by this viewer.</footer>
  </div>

  <script type="application/json" id="trajectory-data">${data}</script>
  <script>
    (() => {
      'use strict';
      const data = JSON.parse(document.getElementById('trajectory-data').textContent);
      const events = Array.isArray(data.events) ? data.events : [];
      const cards = Array.from(document.querySelectorAll('[data-event-index]'));
      const filters = Array.from(document.querySelectorAll('[data-filter]'));
      const empty = document.getElementById('empty-state');
      const fields = {
        kind: document.getElementById('inspector-kind'),
        time: document.getElementById('inspector-time'),
        seq: document.getElementById('inspector-seq'),
        id: document.getElementById('inspector-id'),
        json: document.getElementById('inspector-json')
      };
      const formatTime = (value) => Number.isFinite(value) ? new Date(value).toLocaleString() : 'Timestamp unavailable';
      const select = (index) => {
        const event = events[index];
        if (!event) return;
        cards.forEach((card) => card.setAttribute('aria-current', String(Number(card.dataset.eventIndex) === index)));
        fields.kind.textContent = String(event.kind || 'unknown');
        fields.time.textContent = formatTime(event.createdAtMs);
        fields.seq.textContent = String(event.seq ?? '—');
        fields.id.textContent = String(event.eventId ?? '—');
        fields.json.textContent = JSON.stringify(event, null, 2);
      };
      const filter = (kind) => {
        let firstVisible = -1;
        cards.forEach((card) => {
          const visible = kind === 'all' || card.dataset.kind === kind;
          card.hidden = !visible;
          if (visible && firstVisible < 0) firstVisible = Number(card.dataset.eventIndex);
        });
        filters.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.filter === kind)));
        empty.style.display = firstVisible < 0 ? 'block' : 'none';
        if (firstVisible >= 0) select(firstVisible);
      };
      cards.forEach((card) => card.addEventListener('click', () => select(Number(card.dataset.eventIndex))));
      filters.forEach((button) => button.addEventListener('click', () => filter(button.dataset.filter || 'all')));
      filter('all');
    })();
  </script>
</body>
</html>`;
}

async function ensurePhysicalDirectory(target) {
  await mkdir(target, { recursive: true });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('html_output_directory_unsafe');
}

function metric(value, label) {
  return `<div class="metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

function eventTone(kind) {
  if (kind.startsWith('session.')) return kind.includes('deleted') ? 'state' : 'session';
  if (kind.startsWith('message.')) return kind.includes('deleted') || kind.includes('retracted') ? 'state' : 'message';
  return 'other';
}

function shortKind(kind) {
  return kind.replace('message.', '').replace('session.', 'session · ').replaceAll('_', ' ');
}

function eventSubtitle(event) {
  if (event?.message?.messageKind) return String(event.message.messageKind);
  if (event?.message?.role) return `${String(event.message.role)} · ${String(event.message.toolCallCount ?? 0)} tools`;
  if (Array.isArray(event?.messages)) return `${event.messages.length} Pi messages`;
  if (event?.session?.status) return `status ${String(event.session.status)}`;
  if (event?.snapshotCreated) return 'snapshot checkpoint';
  return String(event?.eventId ?? 'ledger event');
}

function formatDuration(value) {
  const milliseconds = Math.max(0, finiteNumber(value, 0));
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTimestamp(value) {
  const number = finiteNumber(value, undefined);
  return number === undefined ? 'Timestamp unavailable' : new Date(number).toISOString();
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { notation: Number(value) >= 10_000 ? 'compact' : 'standard' }).format(Number(value) || 0);
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(String(value));
}

function safeFilePart(value) {
  const normalized = value.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 64);
  return normalized || 'session';
}
