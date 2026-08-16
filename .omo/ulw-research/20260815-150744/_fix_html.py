# -*- coding: utf-8 -*-
"""Apply proofread fixes to report.html via exact unicode-safe replacement."""
from pathlib import Path

p = Path(r"C:\Users\steve\Desktop\projects\impromptu-r2\.omo\ulw-research\20260815-150744\report.html")
s = p.read_text(encoding="utf-8")

REPLS = [
    # 1. hero title + subtitle
    ("<h1>웹 업로드 UI와 사용자 단말 발표 — 구현 방안 리서치</h1>",
     "<h1>웹 업로드 UI 및 사용자 단말용 발표 기능 리서치 보고서</h1>"),
    ('<p class="subtitle">PPT/PPTX/PDF를 웹에서 업로드하고 발표자가 자기 기기로 발표할 수 있게 하려면 무엇을 어떻게 만들 것인가 — 17개 워커(8인 팀 + 9개 레인), 4라운드 토론, 2건 코드 검증을 거친 종합 보고서.</p>',
     '<p class="subtitle">PPT/PPTX/PDF를 웹에서 업로드하고 발표자가 자기 기기로 발표할 수 있게 하려면 무엇을 어떻게 만들 것인가. 워커 17개(팀 워커 8개 + 레인 워커 9개), 토론 4라운드, 코드 검증 2건을 거친 종합 보고서.</p>'),
    # 2. lead paragraph
    ('<p class="lead">지금 "원하는 슬라이드를 넣을 수 없는" 것은 버그가 아니라 <b>업로드 기능 자체가 아직 없다</b>는 뜻입니다. 그리고 단순히 업로드 버튼을 붙이는 것만으로는 끝나지 않습니다 — 이 저장소에는 <b>렌더링 파이프라인이 전혀 없어서</b>, 업로드된 파일을 화면에 띄우는 경로 자체가 새로 만들어져야 합니다.</p>',
     '<p class="lead">현재 원하는 슬라이드를 추가할 수 없는 이유는 버그가 아니라 <b>업로드 기능 자체가 아직 없기 때문</b>입니다. 그리고 업로드 버튼을 추가하는 것만으로는 끝나지 않습니다. 이 저장소에는 <b>렌더링 파이프라인이 전혀 없어서</b>, 업로드한 파일을 화면에 표시하는 경로를 새로 만들어야 합니다.</p>'),
    # 3. recommendation callout (add boundary statement)
    ('<b>권고 (skeptic 토론 확정):</b> 첫 데모는 <b>private upload + operator 수동 렌더·리뷰·발행</b> 경로로 가는 것이 옳습니다. 항상 켜져 있는 자동 변환 서비스(Gotenberg 등)는 ~10명 데모 규모에서 과설계입니다.',
     '<b>권고 (skeptic 토론 확정):</b> 첫 데모는 <b>비공개 업로드 후 운영자가 수동으로 렌더링, 검토, 발행하는 방식</b>입니다. 항상 켜져 있는 자동 변환 서비스(Gotenberg 등)는 데모 규모에서 과설계입니다.\n    <br><b>경계 선언 (PRIVATE_INTAKE):</b> 업로드는 발표자의 비공개 영역에만 저장되며, 운영자의 렌더링·검토·비공개 해제 전에는 어떤 공개 URL이나 카드, Stage 이미지도 생성되지 않습니다. 자동으로 공개 상태로 전환되지 않습니다.'),
    # 4. diagnosis table rows
    ('<span class="pill bad">없음</span> 파일 입력·드래그드롭·업로드 컴포넌트 전무. 유일한 "Uploader"는 마이크 스트림용',
     '<span class="pill bad">없음</span> 파일 입력, 드래그 앤드 드롭, 업로드 컴포넌트가 전혀 없음. 유일한 업로더(<code>CaptureUploader</code>)는 마이크 스트림 전송용'),
    ('(2개 독립 워커 수렴)', '(독립 워커 2개의 조사 결과가 일치함)'),
    ('<span class="pill warn">스텁</span> <code>{title, content}</code> JSON 텍스트를 해시해 가짜 이미지 URL(<code>public.example.test</code>) 생성',
     '<span class="pill warn">스텁</span> <code>{title, content}</code> JSON 텍스트를 해시해 가짜 이미지 URL(<code>public.example.test</code>)을 생성함'),
    ('<span class="pill warn">CLI 전용</span> HTTP 표면 없는 Python 워커. TS 소비자 전무',
     '<span class="pill warn">CLI 전용</span> HTTP 인터페이스가 없는 Python 워커이며 TypeScript 호출 코드가 없음'),
    ('<span class="pill bad">전무</span> <code>render_slides()</code>가 <code>RenderingUnsupportedError</code>를 던짐 — 그러나 공개 계약은 슬라이드마다 이미지 요구',
     '<span class="pill bad">전무</span> <code>render_slides()</code>가 <code>RenderingUnsupportedError</code>를 던짐. 공개 데크 계약에서는 슬라이드마다 이미지를 요구함'),
    ('(lead 직접 재독 검증)', '(리드가 다시 확인)'),
    ('<span class="pill bad">없음</span> 12개 마이그레이션 어디에도 없음. PostgreSQL large-object 함수는 PUBLIC에서 REVOKE',
     '<span class="pill bad">없음</span> 마이그레이션 12개 어디에도 존재하지 않음. PostgreSQL large-object 함수는 PUBLIC에서 REVOKE됨'),
    ('<span class="pill good">재사용 가능</span> <code>__Host-account</code> + CSRF + origin/referer 검증이 이미 완성',
     '<span class="pill good">재사용 가능</span> <code>__Host-account</code> + CSRF + <code>Origin</code>/<code>Referer</code> 검증이 이미 구현되어 있음'),
    # 5. core defect callout
    ('<b>핵심 결함:</b> <code>createPresentation</code>은 <b>private + public 데크가 함께</b> 있을 때만 성공합니다(<code>prepared-evidence.ts:492-514</code>). public 데크는 렌더링 이미지를 요구하는데 렌더링이 없으므로, <b>현재 코드로는 어떤 업로드도 서빙 가능한 발표가 될 수 없습니다.</b>',
     '<b>핵심 결함:</b> <code>createPresentation</code>은 <b>비공개 데크와 공개 데크가 함께</b> 있을 때만 성공합니다(<code>prepared-evidence.ts:492-514</code>). 공개 데크는 렌더링 이미지를 요구하는데 렌더링이 없으므로, <b>현재 코드로는 어떤 업로드도 실제로 제공할 수 있는 발표가 될 수 없습니다.</b>'),
    # 6. architecture table rows
    ('동일출처 단일 <code>multipart/form-data</code> POST.',
     '동일 출처의 단일 <code>multipart/form-data</code> POST.'),
    ('<b>지금은 도입하지 않음.</b> 오브젝트 스토리지 도입 후 ≥100MiB 또는 불안정 네트워크에서 presigned multipart로',
     '<b>지금은 도입하지 않음.</b> 오브젝트 스토리지를 도입한 뒤, 파일 크기 상한을 100MiB보다 높이거나 불안정 네트워크가 확인되면 사전 서명 멀티파트 업로드로 전환'),
    ('private-backend에 주입된 async <b>subprocess 어댑터</b>로 기존 CLI 호출. 큐는 스키마/계약 부재로 부적절, 독립 Python HTTP 서비스는 미래 스케일아웃',
     'private-backend에 주입된 비동기 <b>서브프로세스 어댑터</b>로 기존 CLI 호출. 큐는 스키마·계약이 없어 부적절. 독립 Python HTTP 서비스는 향후 확장안'),
    ('<code>.pptx</code>/<code>.pdf</code>만, 하드캡 <b>100MiB</b>(코드에 이미 명시), 50MiB 경고',
     '<code>.pptx</code>/<code>.pdf</code>만 허용. 하드 캡 <b>100MiB</b>(코드에 이미 명시), 50MiB에서 경고'),
    ('DB는 <b>메타데이터만</b>(바이트 금지 — large-object REVOKE와 정합). 원본은 account-scoped 스테이징 — <b>파일시스템 스풀 확정</b>: <code>deck_storage_uri</code>에 <code>file:</code> URI 저장(스토리지 비종속 계약), MinIO/R2는 데모에서 제외. 경로는 서버 생성(account+uploadId+hash) — 사용자 파일명 금지',
     'DB에는 <b>메타데이터만</b>(바이트 금지, large-object REVOKE와 일치). 원본은 계정별 스테이징. <b>파일 시스템 스풀 확정</b>: <code>deck_storage_uri</code>에 <code>file:</code> URI 저장(스토리지에 종속되지 않는 계약). MinIO와 R2는 데모에서 제외. 경로는 서버가 생성한 값(<code>account+uploadId+hash</code>)을 사용하며 사용자 파일명 금지'),
    ('operator 수동 렌더(LibreOffice→PDF→poppler→PNG 참조) 후 기존 <code>createPresentation</code> 흐름. 래스터라이즈는 기존 PyMuPDF 바운디드 워커(<code>get_pixmap()</code>)와 poppler를 한국어 코퍼스로 벤치마크해 결정 (C61). PDF.js는 클라이언트 프리뷰 전용 — 공개 아티팩트 경로로 사용 금지',
     '운영자가 수동 렌더링(LibreOffice→PDF→Poppler→PNG 참조) 후 기존 <code>createPresentation</code> 흐름. 래스터라이저는 기존 PyMuPDF(리소스 제한 적용 워커의 <code>get_pixmap()</code>)와 Poppler를 한국어 검증용 코퍼스로 비교해 결정 (C61). PDF.js는 클라이언트 미리보기 전용이며 공개 아티팩트 경로로 사용 금지'),
    ('5초 SLO는 <b>라이브 추천 전용</b>(<code>semantic-audio-end</code>). 업로드 변환에는 별도 async UX/SLO 계약 필요',
     '5초 SLO는 <b>라이브 추천 전용</b>(<code>semantic-audio-end</code>)이며 업로드 변환에는 적용되지 않음. 별도의 비동기 UX/SLO 계약 필요'),
    # 7. integration section
    ('<h3>3.2 최소-diff 통합 지점 (ingestion-integration FINAL)</h3>',
     '<h3>3.2 최소 변경 통합 지점 (ingestion-integration FINAL)</h3>'),
    ('<code>uploadDeck(csrfToken, file)</code> — <code>FormData</code> 사용, Content-Type 수동 설정 금지',
     '<code>uploadDeck(csrfToken, file)</code> 추가. <code>FormData</code>를 사용하며 <code>Content-Type</code>을 직접 설정하지 않음'),
    ('<code>extractedText</code>는 구조 요소 결정적 평탄화',
     '<code>extractedText</code>는 구조 요소를 결정론적으로 평탄화'),
    # 8. security cards
    ('현재 PPTX는 인-프로세스에서 타임아웃·격리·픽셀 예산 없이 파싱됩니다(D1). 웹 경로가 PPTX를 파싱하기 전에 killable 워커/컨테이너(데드라인, 리소스 상한, 동시성 제한) 필수.',
     '현재 PPTX는 프로세스 내부에서 타임아웃·격리·픽셀 예산 없이 파싱됩니다(D1). 웹 경로가 PPTX를 파싱하기 전에 강제 종료 가능한 워커·컨테이너(데드라인, 리소스 상한, 동시성 제한)가 필요합니다.'),
    ('<h4>🚫 액티브 콘텐츠 reject <span class="pill bad">MUST-FIX</span></h4>',
     '<h4>🚫 액티브 콘텐츠 거부 <span class="pill bad">MUST-FIX</span></h4>'),
    ('리네임된 <code>.pptm</code>이 현재 검증을 통과합니다(C45).',
     '이름을 바꾼 <code>.pptm</code>이 현재 검증을 통과합니다(C45).'),
    ('<h4>📌 PyMuPDF 핀 <span class="pill warn">필수</span></h4>',
     '<h4>📌 PyMuPDF 버전 고정 <span class="pill warn">필수</span></h4>'),
    ('<code>&gt;=1.28.0</code> 핀 + advisory 게이트(C44).',
     '<code>&gt;=1.28.0</code>으로 고정하고 보안 권고 검사 도입(C44).'),
    ('<h4>🧹 retention 갭</h4>',
     '<h4>🧹 보존 정책 공백</h4>'),
    ('스풀 루트 TTL/orphan 스윕 필요(사용자 경로 순회 금지)(C59).',
     '스풀 루트의 TTL 기반 고아 파일 정리 필요(사용자 경로 순회 금지)(C59).'),
    # 9. UX section
    ('실패 시: "63%에서 연결 끊김, 처음부터 재시도" 명시 + idempotency 키',
     '실패 시: "63%에서 연결이 끊겼습니다. 처음부터 다시 시도합니다."라고 명시하고 멱등성 키 사용'),
    ('Service Worker는 non-GET 요청을 완전 바이패스 (C54)',
     'Service Worker는 일반 업로드 요청(non-GET)을 완전히 우회. 단, Web Share Target 파일 수신 경로는 예외적으로 가로챔 (C54)'),
    ('파일 진입: in-app 피커+drag-drop 기본; 데스크톱 설치 PWA는',
     '파일 입력 방식: 앱 내 파일 선택기와 드래그 앤드 드롭이 기본. 데스크톱 설치 PWA는'),
    # 10. competitor section
    ('(참고: "~10명 동시 사용자"는 DEMO-SCOPE.md에 명시된 수치가 아니라 계획상 가정입니다 — C42/C64.)',
     '(참고: "동시 사용자 약 10명"은 <code>DEMO-SCOPE.md</code>에 명시된 수치가 아니라 계획상 가정입니다. C42/C64.)'),
    # 11. open items
    ('데모 기준 ~4-5GiB 전용 쿼터(최악 10×100MiB 소스+복사 ≈ 2GiB), 동시 파싱 풀 시작 2(벤치마크 후 4), 초과 시 429/503',
     '데모 기준 약 4~5GiB 전용 쿼터(최악 10×100MiB 소스+복사 ≈ 2GiB). 동시 파싱 풀은 2개로 시작해 벤치마크 후 4개로 확장. 초과 시 429/503'),
]

missing = []
for old, new in REPLS:
    if old in s:
        s = s.replace(old, new)
    else:
        missing.append(old[:60])

p.write_text(s, encoding="utf-8", newline="\n")
print(f"applied {len(REPLS) - len(missing)}/{len(REPLS)} replacements")
for m in missing:
    print("NOT FOUND:", m)
