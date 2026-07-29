/**
 * rhwp 워커 — 사이드카(Python)가 부르는 한글(HWP) 편집 다리.
 *
 * 왜 워커인가
 * ----------
 * rhwp(@rhwp/core)는 Rust+WASM Node 라이브러리라 Python 에서 직접 못 부른다. 그래서 민규의
 * kordoc 워커와 같은 방식으로, 장수(long-lived) Node 프로세스를 하나 띄우고 stdin 으로 JSON
 * 요청을, stdout 으로 JSON 응답을 주고받는다.
 *
 * 이 워커는 앱의 rhwp 편집 로직(fill.ts)을 그대로 옮긴 것이다 — 표의 논리 셀을 인덱스로
 * 읽고/쓰고, 채운 뒤 **재파싱으로 검증**하고, 한 칸이라도 어긋나면 결과를 지우고 실패한다.
 * "채운 줄 알았는데 빈 보고서"가 나가지 않게 하는 것이 핵심이다.
 *
 * 실행:  node rhwp_worker.mjs <staging_root> <rhwp_root>
 *   staging_root  — 입출력 파일이 놓이는 디렉터리. 이 밖의 경로는 거부한다(경로 탈출 방지).
 *   rhwp_root     — node_modules/@rhwp/core 가 있는 디렉터리(앱 설치 위치).
 */
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const [stagingArg, rhwpArg] = process.argv.slice(2);
if (!stagingArg || !rhwpArg) {
  process.stderr.write('usage: node rhwp_worker.mjs <staging_root> <rhwp_root>\n');
  process.exit(2);
}
const stagingRoot = await realpath(stagingArg);
const rhwpRoot = await realpath(rhwpArg);

// @rhwp/core 를 앱 설치 위치에서 로드하고 WASM 을 초기화한다(fill.ts 와 동일한 절차).
const requireFromRhwp = createRequire(path.join(rhwpRoot, 'package.json'));
const rhwp = requireFromRhwp('@rhwp/core');
const rhwpDir = path.dirname(requireFromRhwp.resolve('@rhwp/core'));
const wasm = fs.readFileSync(path.join(rhwpDir, 'rhwp_bg.wasm'));
rhwp.initSync({ module: wasm });
const rhwpVersion = JSON.parse(
  fs.readFileSync(path.join(rhwpRoot, 'node_modules', '@rhwp', 'core', 'package.json'), 'utf8'),
).version;

/** staging 안으로만 경로를 가둔다 — 상대 경로만 받고 밖으로 나가면 거부. */
function safePath(relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) {
    throw new Error('unsafe path');
  }
  const resolved = path.resolve(stagingRoot, relative);
  if (resolved !== stagingRoot && !resolved.startsWith(stagingRoot + path.sep)) {
    throw new Error('path escapes staging root');
  }
  return resolved;
}

/** (섹션 0)에서 문단·컨트롤을 훑어 빈 칸이 있는 첫 표를 찾는다(fill.ts findFirstTable). */
function findFirstTable(doc) {
  for (let para = 0; para < 60; para += 1) {
    for (let control = 0; control < 8; control += 1) {
      try {
        const dim = JSON.parse(doc.getTableDimensions(0, para, control));
        if (dim.cellCount > 0) return { section: 0, para, control, cellCount: dim.cellCount };
      } catch {
        /* 이 자리에 표 없음 */
      }
    }
  }
  return null;
}

function readCells(doc, table) {
  const cells = [];
  for (let cellIndex = 0; cellIndex < table.cellCount; cellIndex += 1) {
    let text = '';
    try {
      text = doc.getTextInCell(table.section, table.para, table.control, cellIndex, 0, 0, 9999);
    } catch {
      /* 병합으로 가려진 셀 */
    }
    cells.push({ cellIndex, text: (text ?? '').trim() });
  }
  return cells;
}

async function openDoc(relative) {
  const bytes = new Uint8Array(await fsp.readFile(safePath(relative)));
  return new rhwp.HwpDocument(bytes);
}

// ---- 명령 처리 -------------------------------------------------------------

async function handle(request) {
  const { command } = request;

  if (command === 'ping') {
    return { ok: true, rhwp_version: rhwpVersion };
  }

  if (command === 'read_structure') {
    const doc = await openDoc(request.input);
    const table = findFirstTable(doc);
    if (!table) return { ok: false, error: 'no_table', message: '양식에서 표를 찾지 못했습니다.' };
    return { ok: true, table, cells: readCells(doc, table) };
  }

  if (command === 'fill') {
    // values: { "<cellIndex>": "<text>" }
    const input = safePath(request.input);
    const output = safePath(request.output);
    if (path.resolve(input) === path.resolve(output)) {
      return { ok: false, error: 'same_path', message: '원본과 출력 경로가 같습니다.' };
    }
    const doc = await openDoc(request.input);
    const table = findFirstTable(doc);
    if (!table) return { ok: false, error: 'no_table', message: '양식에서 표를 찾지 못했습니다.' };

    const values = new Map(
      Object.entries(request.values ?? {}).map(([k, v]) => [Number(k), String(v)]),
    );
    const filled = [];
    const skipped = [];
    for (const [cellIndex, value] of values) {
      const text = value.trim();
      if (!text) continue;
      try {
        doc.insertTextInCell(table.section, table.para, table.control, cellIndex, 0, 0, text);
        filled.push(cellIndex);
      } catch {
        skipped.push(cellIndex);
      }
    }

    const bytes = doc.exportHwp();
    await fsp.writeFile(output, Buffer.from(bytes), { flag: 'wx' });

    // 재파싱 검증 — 넣은 값이 실제로 들어갔는지. 한 칸이라도 어긋나면 지우고 실패.
    const verify = new rhwp.HwpDocument(new Uint8Array(await fsp.readFile(output)));
    const vt = findFirstTable(verify);
    const unverified = [];
    for (const cellIndex of filled) {
      const expected = (values.get(cellIndex) ?? '').trim();
      let actual = '';
      try {
        actual = verify.getTextInCell(vt.section, vt.para, vt.control, cellIndex, 0, 0, 9999) ?? '';
      } catch {
        /* 확인 실패 */
      }
      if (!actual.includes(expected)) unverified.push(cellIndex);
    }
    if (unverified.length > 0) {
      await fsp.rm(output, { force: true });
      return {
        ok: false,
        error: 'verify_failed',
        message: `채운 값이 저장되지 않은 칸이 있습니다 (${unverified.length}곳).`,
        unverified,
      };
    }
    return { ok: true, filled, skipped, verified: true };
  }

  return { ok: false, error: 'unknown_command', message: `알 수 없는 명령: ${command}` };
}

// ---- stdin/stdout JSON 루프 -------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'bad_json' }) + '\n');
    return;
  }
  const id = request.id;
  try {
    const result = await handle(request);
    process.stdout.write(JSON.stringify({ id, ...result }) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ id, ok: false, error: 'worker_error', message: String(error?.message ?? error) }) +
        '\n',
    );
  }
});

// 준비 완료 신호(선택). Python 쪽은 요청-응답으로만 동기화하므로 필수는 아니다.
process.stderr.write(`rhwp_worker ready (rhwp ${rhwpVersion})\n`);
