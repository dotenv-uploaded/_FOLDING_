import type { BuildPhase, BuildState } from '@contracts';

/**
 * 빌드가 도는 동안 사람에게 건네는 한 줄.
 *
 * 왜 문장을 바꾸는가
 * -----------------
 * 빌드는 몇 분씩 걸린다. 그동안 "정리 중" 한 줄만 떠 있으면 화면이 멈춘 것처럼 보이고,
 * 무엇보다 **지금 무엇이 벌어지는지** 알 수 없다. 문장이 단계에 따라 바뀌면 진행률 막대가
 * 말해 주지 못하는 것 — 지금 원본을 읽는지, 문서의 말을 듣는지, 관계를 잇는지 — 가 드러난다.
 *
 * 이 앱이 만드는 것은 파일 더미가 아니라 **서로 이어져 살아나는 지식체**다. 문장도 그렇게
 * 쓴다. 다만 **없는 일을 지어내지는 않는다** — 각 문장은 그 단계가 실제로 하는 일을 말한다.
 *
 * 실패는 꾸미지 않는다
 * -------------------
 * 실패했을 때만은 시적인 문장을 쓰지 않는다. 무엇이 잘못됐는지 알아야 하는 순간에 비유를
 * 들이밀면 사용자는 두 번 읽어야 한다.
 *
 * 흔들리지 않는다
 * --------------
 * 진행률은 초당 여러 번 갱신된다. 문장을 그때마다 새로 뽑으면 글자가 떨려 읽을 수 없다.
 * 그래서 **시간 구간(약 7초)마다 한 칸씩** 넘어가고, 같은 상태에서는 언제나 같은 문장이 나온다.
 */

/** 한 문장이 머무는 시간. 짧으면 어지럽고, 길면 멈춘 것처럼 보인다. */
const ROTATE_MS = 7000;

/** 폴더를 훑는 동안 — 아직 단계가 정해지기 전. */
const SCANNING = [
  '폴더를 둘러보는 중',
  '무엇이 있는지 세어 보는 중',
  '문서를 불러 모으는 중',
];

const BY_PHASE: Record<BuildPhase, string[]> = {
  // 원본(hwp·docx·pdf)을 읽어 마크다운으로 옮기는 단계.
  convert: [
    '문서를 한 장씩 펼치는 중',
    '종이에 잠든 글자를 깨우는 중',
    '표와 문단의 뼈대를 세우는 중',
    '원본의 결을 따라 옮겨 적는 중',
    '겹겹이 쌓인 서식을 걷어 내는 중',
  ],
  // 문서마다 무엇을 말하는지(요지·등장하는 이름) 뽑아 두는 단계.
  enrich: [
    '문서가 무슨 말을 하는지 듣는 중',
    '오간 이름과 날짜를 기억하는 중',
    '문서마다 요지를 새기는 중',
    '누가 무엇을 했는지 알아보는 중',
    '문서에 묻힌 이름들을 건져 올리는 중',
  ],
  // 문서 사이의 관계를 잇고 불변 빌드로 굳히는 단계.
  assemble: [
    '문서 사이에 실을 잇는 중',
    '같은 이름을 부르는 문서끼리 손을 잡는 중',
    '흩어져 있던 점들이 서로를 찾는 중',
    '지식의 실핏줄이 뻗어 나가는 중',
    '그래프가 제 모양을 갖추는 중',
  ],
};

/** 거의 끝났을 때. 여기까지 오면 남은 일은 매듭짓는 것뿐이다. */
const FINISHING = ['마지막 매듭을 짓는 중', '지식체에 숨을 불어넣는 중'];

/** 이 비율을 넘으면 마무리 문장으로 바꾼다. */
const FINISHING_FROM = 96;

/**
 * 문서 패널 맨 위에 걸리는 한 줄.
 *
 * 진행률·단계·건수 같은 **사실은 이 줄 아래에 그대로 남는다.** 이 줄은 그것을 대신하는 것이
 * 아니라, 숫자가 말해 주지 못하는 "지금 무슨 일이 벌어지는가"를 얹는 자리다.
 */
export function buildHeadline(build: BuildState | null): string {
  if (!build) return '최신 상태';
  if (build.status === 'failed') return '빌드 실패'; // 실패는 꾸미지 않는다
  if (build.status === 'idle' || build.status === 'done') return '최신 상태';

  const step = rotation(build);
  if (build.progress >= FINISHING_FROM) return pick(FINISHING, build, step);
  const phrases = build.phase ? BY_PHASE[build.phase.name] : SCANNING;
  return pick(phrases, build, step);
}

/**
 * 지금이 몇 번째 칸인지 — 시간으로 정한다.
 *
 * `updatedAt` 은 빌드가 진행을 알릴 때마다 갱신되므로, 이걸 구간으로 나누면 리렌더 횟수와
 * 무관하게 **실제로 흐른 시간만큼만** 문장이 넘어간다.
 */
function rotation(build: BuildState): number {
  const at = Date.parse(build.updatedAt);
  return Number.isNaN(at) ? 0 : Math.floor(at / ROTATE_MS);
}

/**
 * 목록에서 한 문장을 고른다.
 *
 * 시작 위치는 빌드마다 다르게(그래야 빌드를 돌릴 때마다 같은 순서로 시작하지 않는다), 이후로는
 * **한 칸씩 앞으로**만 간다. 무작위로 뽑으면 같은 문장이 연달아 나와 멈춘 것처럼 보인다.
 */
function pick(phrases: string[], build: BuildState, step: number): string {
  const offset = hash(`${build.buildId ?? ''}:${build.phase?.name ?? 'scan'}`);
  return phrases[(offset + step) % phrases.length]!;
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}
