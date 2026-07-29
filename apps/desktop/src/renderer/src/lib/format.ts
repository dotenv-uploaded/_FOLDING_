/**
 * 표시용 포매터.
 * 백엔드는 날짜를 ISO 8601 로 준다 — 사용자에게 그대로 보여주지 않는다.
 */

/**
 * ISO 날짜 → `2026-12-31`. 파싱에 실패하면 원문을 그대로 돌려준다.
 *
 * **UTC 기준으로 읽는다.** 백엔드는 만료를 `2026-12-31T23:59:59Z` 처럼 그 날의 끝으로
 * 표현하는데, 이를 KST(+9)로 환산하면 2027-01-01 이 되어 하루 밀려 보인다.
 * 사용자가 기대하는 건 "12월 31일까지"이므로 시간대 변환 없이 날짜 부분만 쓴다.
 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 문서를 화면에서 부를 이름 — **파일 이름**이다.
 *
 * 위키 빌드의 `title` 은 문서의 첫 글줄에서 뽑는다. 사람이 쓴 문서에서 그건 제목이 아닐
 * 때가 많다: "※ 굴림체, 10포인트, 장평100%…", "Quiz.", "두번째", "제공하는". 그래프에
 * 이런 이름이 뜨면 어느 파일인지 알 수 없고, 같은 양식으로 만든 문서 수십 개가 전부 같은
 * 이름으로 겹쳐 보인다.
 *
 * 파일 이름은 사람이 직접 붙인 이름이라 그런 문제가 없다. 확장자는 뗀다 — 폴더에서 보던
 * 이름과 같아야 알아본다.
 */
export function documentLabel(document: {
  title?: string;
  sourceFilename?: string;
  sourceUri?: string;
  docId?: string;
}): string {
  const fromFile =
    nameFromPath(document.sourceFilename) || nameFromPath(decodeUri(document.sourceUri));
  // 파일 정보가 없는 문서(변환 중 원본을 잃은 경우)는 그래도 뭐라도 불러야 한다.
  return fromFile || document.title?.trim() || document.docId || '이름 없는 문서';
}

/**
 * 경로에서 **사람이 붙인 이름**을 찾는다. 확장자는 뗀다.
 *
 * 보통은 파일 이름이 그 이름이다. 그런데 HTML·프레젠테이션을 내보내면
 * `.../assets/3F6BD8FA-…/assets/3F6BD8FA-….pdf` 처럼 UUID 로만 된 파일이 쏟아진다.
 * 그건 기계가 붙인 이름이라 화면에 띄워도 어느 문서인지 알 수 없다. 그럴 때는 위로
 * 거슬러 올라가 처음 만나는 사람의 이름(여기서는 `FLAG홍보자료_신입생OT`)을 쓴다.
 */
function nameFromPath(pathLike: string | undefined): string {
  if (!pathLike) return '';
  const segments = pathLike.replace(/[/\\]+$/, '').split(/[/\\]/);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const name = (i === segments.length - 1 ? stripExtension(segments[i]!) : segments[i]!).trim();
    if (name && !isMachineName(name)) return name;
  }
  return '';
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

/** 기계가 붙인 이름 — UUID·해시·내보내기 폴더. 사람에게는 아무 뜻이 없다. */
function isMachineName(name: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return true;
  if (/^[0-9a-f]{16,}$/i.test(name)) return true;
  return ['assets', 'images', 'media', 'resources'].includes(name.toLowerCase());
}

/** `source://` URI 는 퍼센트 인코딩돼 있다 — 못 풀면 원문 그대로 둔다. */
function decodeUri(uri: string | undefined): string {
  if (!uri) return '';
  const withoutScheme = uri.replace(/^source:\/\//, '');
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

/** 상대 시각 — 채팅 목록용. */
export function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return '방금';
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}시간 전`;
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
}
