import { describe, expect, it } from 'vitest';
import { documentLabel } from '@renderer/lib/format';

/**
 * 문서를 화면에서 부를 이름.
 *
 * 아래 사례는 전부 **실제 빌드(manifest.jsonl)에서 그대로 가져온 것**이다. 위키가 문서의
 * 첫 글줄을 제목으로 뽑는 바람에, 그래프에 "※ 굴림체, 10포인트…" 나 "Quiz." 같은 이름이
 * 떴고 같은 양식으로 만든 문서 수십 개가 전부 같은 이름으로 겹쳐 보였다.
 */
describe('documentLabel', () => {
  it('첫 글줄에서 뽑힌 엉뚱한 제목 대신 파일 이름을 쓴다', () => {
    expect(
      documentLabel({
        title: '※ 굴림체, 10포인트, 장평100%, 자간 0%, 줄 간격 160% 반드시 서식을 준수하여 작성할 것',
        sourceFilename:
          '목표 달성 스터디 학습활동 보고서/2주차 목표 달성 스터디 학습활동 보고서_정호성 양식.hwp',
      }),
    ).toBe('2주차 목표 달성 스터디 학습활동 보고서_정호성 양식');
  });

  it('같은 제목이 붙던 문서들이 파일 이름으로 갈라진다', () => {
    const shared = 'FLAG 스터디 주간 활동 보고서';
    const labels = [
      'FLAG Flutter 스터디 보고서/Flutter 스터디 5주차.docx',
      'FLAG Spring_Kotlin 스터디 보고서/FLAG 스터디 주간 보고서0415_0417.docx',
    ].map((sourceFilename) => documentLabel({ title: shared, sourceFilename }));

    expect(labels).toEqual(['Flutter 스터디 5주차', 'FLAG 스터디 주간 보고서0415_0417']);
    expect(new Set(labels).size).toBe(2); // 더는 겹치지 않는다
  });

  it('파일 이름이 없으면 URI 에서 찾고, 퍼센트 인코딩을 푼다', () => {
    expect(
      documentLabel({
        title: 'Quiz.',
        sourceUri: 'source://FLAG%20Flutter%20%EC%8A%A4%ED%84%B0%EB%94%94/5%EC%A3%BC%EC%B0%A8.pdf',
      }),
    ).toBe('5주차');
  });

  it('풀 수 없는 인코딩이어도 그 문서를 잃지 않는다', () => {
    // 깨진 URI 하나 때문에 노드가 이름 없이 뜨는 것보다, 있는 글자라도 보여주는 편이 낫다.
    expect(documentLabel({ sourceUri: 'source://망가진%ZZ/보고서.hwp' })).toBe('보고서');
  });

  it('파일 정보가 아예 없으면 제목, 그것도 없으면 식별자로 부른다', () => {
    expect(documentLabel({ title: '회의록', docId: 'doc-7' })).toBe('회의록');
    expect(documentLabel({ docId: 'doc-7' })).toBe('doc-7');
    expect(documentLabel({})).toBe('이름 없는 문서');
  });

  it('확장자만 떼고 이름 안의 점은 건드리지 않는다', () => {
    expect(documentLabel({ sourceFilename: '보고서 v1.2 최종.docx' })).toBe('보고서 v1.2 최종');
  });

  it('UUID 로만 된 파일은 위로 올라가 사람이 붙인 이름을 찾는다', () => {
    // HTML·발표자료를 내보내면 이런 파일이 쏟아진다. 이 빌드에서는 119개 중 52개가 그랬다.
    // 파일 이름을 그대로 쓰면 화면이 UUID 로 뒤덮여 어느 자료인지 알 수 없다.
    expect(
      documentLabel({
        title: 'Quiz.',
        sourceFilename:
          '신입생OT 발표자료 HTML/FLAG홍보자료_신입생OT/assets/3F6BD8FA-7E76-4373-AF7F-F1E629D86565/assets/3F6BD8FA-7E76-4373-AF7F-F1E629D86565.pdf',
      }),
    ).toBe('FLAG홍보자료_신입생OT');
  });

  it('사람이 붙인 이름이 경로 어디에도 없으면 제목으로 돌아간다', () => {
    expect(
      documentLabel({ title: '회의록', sourceFilename: 'assets/9f2c1b7d4e6a8c0f5b3d.pdf' }),
    ).toBe('회의록');
  });
});
