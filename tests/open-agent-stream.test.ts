/**
 * 열린 에이전트 스트림 — SSE 조각 맞추기와 승인 왕복.
 *
 * 이 두 곳이 조용히 깨지기 쉽다:
 *   - SSE 청크는 이벤트 경계와 무관하게 잘려 온다. 경계를 무시하면 긴 이벤트에서
 *     JSON 이 깨지는데, 그 깨짐은 "답이 조금 이상하다" 로만 보여 놓치기 쉽다.
 *   - 승인 결과를 await 로 붙잡으면 스트림을 못 읽어 교착에 빠진다. 사이드카는 답을
 *     기다리며 멈춰 있고, 앱은 다음 이벤트를 기다리며 멈춘다.
 */
import { describe, expect, it } from 'vitest';
import { parseSseEvents, type SidecarAgentEvent } from '../src/main/sidecar/client';

/** 주어진 문자열 조각들을 그대로 흘려보내는 스트림. 청크 경계를 시험에 쓴다. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SidecarAgentEvent[]> {
  const events: SidecarAgentEvent[] = [];
  for await (const event of parseSseEvents(streamOf(chunks))) events.push(event);
  return events;
}

describe('parseSseEvents', () => {
  it('한 청크에 여러 이벤트가 들어와도 모두 꺼낸다', async () => {
    const events = await collect([
      'data: {"type": "text", "text": "안녕"}\n\ndata: {"type": "done", "cost_usd": 0.1}\n\n',
    ]);
    expect(events).toEqual([
      { type: 'text', text: '안녕' },
      { type: 'done', cost_usd: 0.1 },
    ]);
  });

  it('이벤트 하나가 여러 청크에 걸쳐 와도 이어 붙인다', async () => {
    // 실제로 이렇게 잘려 온다 — JSON 한가운데에서 끊긴다.
    const events = await collect(['data: {"type": "te', 'xt", "text": "나뉘', '어 왔다"}\n\n']);
    expect(events).toEqual([{ type: 'text', text: '나뉘어 왔다' }]);
  });

  it('멀티바이트 문자가 청크 경계에서 잘려도 깨지지 않는다', async () => {
    // 한글은 UTF-8 로 3바이트다. 바이트 한가운데서 끊어 디코딩이 버티는지 본다.
    const encoder = new TextEncoder();
    const whole = encoder.encode('data: {"type": "text", "text": "한글"}\n\n');
    const cut = 30; // '한' 의 바이트 중간
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(whole.slice(0, cut));
        controller.enqueue(whole.slice(cut));
        controller.close();
      },
    });
    const events: SidecarAgentEvent[] = [];
    for await (const event of parseSseEvents(stream)) events.push(event);
    expect(events).toEqual([{ type: 'text', text: '한글' }]);
  });

  it('마지막 이벤트에 끝 빈 줄이 없어도 흘려보낸다', async () => {
    const events = await collect(['data: {"type": "done", "cost_usd": null}']);
    expect(events).toEqual([{ type: 'done', cost_usd: null }]);
  });

  it('깨진 한 줄 때문에 대화 전체를 죽이지 않는다', async () => {
    const events = await collect([
      'data: {"type": "text", "text": "하나"}\n\n',
      'data: {깨진 JSON\n\n',
      'data: {"type": "done", "cost_usd": null}\n\n',
    ]);
    expect(events).toEqual([
      { type: 'text', text: '하나' },
      { type: 'done', cost_usd: null },
    ]);
  });

  it('승인 요청의 위험도와 사용자 요청을 그대로 전한다', async () => {
    const [event] = await collect([
      'data: {"type": "approval", "approval_id": "appr_1", "tool": "Bash",' +
        ' "risk": "danger", "reason": "파일 삭제(rm)", "summary": "rm -rf /tmp/x",' +
        ' "user_request": "문서 요약해줘"}\n\n',
    ]);
    expect(event).toEqual({
      type: 'approval',
      approval_id: 'appr_1',
      tool: 'Bash',
      risk: 'danger',
      reason: '파일 삭제(rm)',
      summary: 'rm -rf /tmp/x',
      // 요청("요약")과 도구("rm -rf")가 어긋난다 — 사람이 이걸 보고 잡는다.
      user_request: '문서 요약해줘',
    });
  });
});
