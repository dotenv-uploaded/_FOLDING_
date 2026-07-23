export const SUGGESTED_COMMAND_GROUPS = [
  {
    key: 'read',
    label: '읽기',
    description: '문서를 찾고 현재 내용을 확인합니다.',
    commands: ['하드사이언스 실무 책임자 누구야?', '지난달 제출한 신청서 요약해줘'],
  },
  {
    key: 'edit',
    label: '수정',
    description: '원문을 확인한 뒤 변경안을 만듭니다.',
    commands: [
      'test (1).hwp에서 하드사이언스 실무 책임자 이름을 홍성주로 바꿔줘',
      'REG-000001에서 1년을 3년으로 변경해줘',
    ],
  },
  {
    key: 'delete',
    label: '삭제',
    description: '승인 후 파일을 삭제하며 Undo할 수 있습니다.',
    commands: ['test (1).hwp 파일 지워', '계약서 전부 다 지워줘'],
  },
] as const;
