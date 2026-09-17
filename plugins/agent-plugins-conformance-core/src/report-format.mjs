// Saved reports are formatted independently of the current evaluator and case list.
const STATUSES = ['pass', 'fail', 'not_verified'];

function invalid(at, reason) {
  throw new TypeError(`${at}: ${reason}`);
}

function object(value, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(at, 'expected an object');
}

function string(value, at) {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'expected a nonempty string');
}

function strings(value, at) {
  if (!Array.isArray(value)) invalid(at, 'expected an array');
  value.forEach((item, index) => string(item, `${at}[${index}]`));
}

export function validateSavedReport(report) {
  object(report, 'report');
  if (report.schemaVersion !== 1) invalid('report.schemaVersion', 'expected 1');
  string(report.specVersion, 'report.specVersion');
  if (!Array.isArray(report.observations)) invalid('report.observations', 'expected an array');
  if (!Array.isArray(report.results)) invalid('report.results', 'expected an array');
  const counts = { pass: 0, fail: 0, not_verified: 0, total: report.results.length };
  const ids = new Set();
  for (const [index, result] of report.results.entries()) {
    const at = `report.results[${index}]`;
    object(result, at);
    for (const key of ['id', 'label', 'detail']) string(result[key], `${at}.${key}`);
    if (ids.has(result.id)) invalid(`${at}.id`, 'duplicate result ID');
    ids.add(result.id);
    if (!STATUSES.includes(result.status)) invalid(`${at}.status`, `expected one of: ${STATUSES.join(', ')}`);
    strings(result.specSections, `${at}.specSections`);
    counts[result.status] += 1;
  }
  object(report.summary, 'report.summary');
  for (const [status, count] of Object.entries(counts)) {
    if (report.summary[status] !== count) invalid(`report.summary.${status}`, `expected ${count} from saved results`);
  }
  strings(report.notes, 'report.notes');
  return report;
}

export function escapeText(value) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => {
    const escaped = JSON.stringify(character).slice(1, -1);
    return escaped === character ? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}` : escaped;
  });
}

export function formatReport(report) {
  validateSavedReport(report);
  const row = (label, counts) => [
    label.padEnd(11), ...[counts.pass, counts.fail, counts.not_verified].map((count, index) => String(count).padStart(index === 2 ? 12 : 6)),
  ].join('  ');
  const lines = [
    `Agent Plugins conformance — spec ${escapeText(report.specVersion)}`,
    '',
    row('Checks', { pass: 'Passed', fail: 'Failed', not_verified: 'Not verified' }),
  ];
  const groups = new Map();
  for (const result of report.results) {
    const group = result.id.startsWith('skills.') ? 'Skills' : result.id.startsWith('mcp.') ? 'MCP' : 'Other';
    if (!groups.has(group)) groups.set(group, { pass: 0, fail: 0, not_verified: 0 });
    groups.get(group)[result.status] += 1;
  }
  for (const group of ['Skills', 'MCP', 'Other']) {
    if (groups.has(group)) lines.push(row(group, groups.get(group)));
  }
  lines.push(row('Total', report.summary));
  for (const [status, heading] of [['fail', 'Failed'], ['not_verified', 'Not verified']]) {
    const results = report.results.filter((result) => result.status === status);
    if (!results.length) continue;
    lines.push('', heading);
    for (const { id, label, detail } of results) {
      lines.push(`  ${escapeText(label)} (${escapeText(id)})`, `    ${escapeText(detail)}`);
    }
  }
  return lines.join('\n');
}
