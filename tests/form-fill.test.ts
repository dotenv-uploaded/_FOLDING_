import { describe, expect, it } from 'vitest';
import { isFormFillRequest } from '@main/agent/form-fill';
import { placeholderNames } from '@main/kordoc/docx-template';

/**
 * 양식 채우기 요청을 가려내는 문지기.
 *
 * 이 판정이 헐거우면 **평범한 질문까지 가로채** 문서 검색 대신 양식을 채우려 든다.
 * 반대로 너무 좁으면 시연에서 아무 일도 일어나지 않는다. 양쪽을 다 고정한다.
 */
describe('isFormFillRequest', () => {
  it('양식을 채워 달라는 말을 알아본다', () => {
    for (const text of [
      '일일업무보고 양식 채워줘',
      '업무일지 양식에 오늘 내용 작성해줘',
      '보고서 템플릿 채워주세요',
      '일일 업무 보고 만들어줘',
    ]) {
      expect(isFormFillRequest(text), text).toBe(true);
    }
  });

  it('평범한 질문을 가로채지 않는다', () => {
    for (const text of [
      '사업계획서의 콜라겐 주장 근거가 뭐야?',
      '지난달 제출한 신청서 요약해줘',
      '이 문서 어디에 저장돼 있어?',
      '계약서에서 대금 지급 조건 알려줘',
    ]) {
      expect(isFormFillRequest(text), text).toBe(false);
    }
  });
});

describe('placeholderNames', () => {
  it('양식이 요구하는 자리를 모은다', () => {
    expect(placeholderNames('작성자: {{작성자}} / 부서: {{ 부서 }}')).toEqual(['작성자', '부서']);
  });

  it('같은 자리가 여러 번 나와도 한 번만 센다', () => {
    expect(placeholderNames('{{날짜}} ... {{날짜}}')).toEqual(['날짜']);
  });

  it('자리 표시가 아닌 중괄호는 무시한다', () => {
    expect(placeholderNames('{ 그냥 중괄호 } 와 {{}} 빈 것')).toEqual([]);
  });
});
