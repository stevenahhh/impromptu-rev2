# -*- coding: utf-8 -*-
"""Apply 2nd-round proofread fixes to report.html."""
from pathlib import Path

p = Path(r"C:\Users\steve\Desktop\projects\impromptu-r2\.omo\ulw-research\20260815-150744\report.html")
s = p.read_text(encoding="utf-8")

REPLS = [
    # boundary statement
    ("업로드는 발표자의 비공개 영역에만 저장되며, 운영자의 렌더링·검토·비공개 해제 전에는 어떤 공개 URL이나 카드, Stage 이미지도 생성되지 않습니다. 자동으로 공개 상태로 전환되지 않습니다.",
     "업로드는 발표자의 비공개 영역에만 저장되며, 운영자가 렌더링하고 검토한 뒤 발행하기 전에는 어떤 공개 URL이나 카드, Stage 이미지도 생성되지 않습니다. 자동으로 공개 상태로 전환되지 않습니다."),
    # diagnosis table
    ("(독립 워커 2개의 조사 결과가 일치함)", "(독립 워커 두 개가 각각 조사한 결과가 일치함)"),
    ("<span class=\"pill warn\">CLI 전용</span> HTTP 인터페이스가 없는 Python 워커이며 TypeScript 호출 코드가 없음",
     "<span class=\"pill warn\">CLI 전용</span> HTTP 인터페이스가 없는 CLI 전용 Python 워커이며, TypeScript 호출 코드도 없음"),
    ("<b>현재 코드로는 어떤 업로드도 실제로 제공할 수 있는 발표가 될 수 없습니다.</b>",
     "<b>현재 코드로는 업로드한 파일로 실제 발표를 제공할 수 없습니다.</b>"),
    ("PostgreSQL large-object 함수는 PUBLIC에서 REVOKE됨",
     "PostgreSQL 대형 객체 함수의 <code>PUBLIC</code> 권한은 <code>REVOKE</code> 처리됨"),
    # storage row
    ("(바이트 금지, large-object REVOKE와 일치)",
     "(바이트 금지, 대형 객체 권한 회수 정책과 일치)"),
    # integration row
    ("<code>private-backend</code>에 주입된 비동기 <b>서브프로세스 어댑터</b>로 기존 CLI 호출. 큐는 스키마·계약이 없어 부적절. 독립 Python HTTP 서비스는 향후 확장안",
     "`private-backend`에 주입된 비동기 <b>서브프로세스 어댑터</b>로 기존 CLI 호출. 큐는 스키마·계약이 없어 부적절. 독립 Python HTTP 서비스는 향후 확장안"),
    # lifecycle callout
    ("<b>수명주기 계약 (C62):</b> 동기 업로드가 아니라 <b>비동기 job + 폴링</b> — <code>POST multipart</code> → 검증/스테이징/해시 + durable job → <code>202 + jobId</code>. 워커가 렌더링·래스터라이즈·이미지 저장 후 private/public 데크를 원자적으로 <b>READY</b> 처리. 클라이언트는 <code>GET job</code> 폴링. <code>createPresentation</code>은 READY 전까지 불가. (Gotenberg 웹훅은 콜백 인증/SSRF 복잡도 + PDF까지만의 산출물로 채택 안 함)",
     "<b>수명주기 계약 (C62):</b> 업로드 접수와 상태 조회에는 비동기 작업과 폴링을 사용하되, 렌더링은 운영자가 직접 시작합니다. <code>POST multipart</code> → 검증/스테이징/해시 → 작업 레코드 생성 → <code>202 + jobId</code>. 운영자가 대기 작업을 선택해 변환 워커 도구를 수동 실행하고, 워커 도구는 PPTX→PDF→이미지 변환 후 비공개 미리보기로 저장해 <code>READY_PREVIEW</code> 처리. 운영자·발표자가 미리보기를 검토하고 운영자가 승인한 뒤에만 공개 아티팩트로 수동 승격해 <code>createPresentation</code> 실행. (Gotenberg 웹훅은 콜백 인증과 SSRF 방어가 복잡하고 산출물도 PDF에 그치므로 채택하지 않음)"),
    # integration warning
    ("렌더링이 완료되기 전까지 API는 pending/private-only 상태를 반환해야 합니다.",
     "렌더링 완료 전까지 API는 처리 중이거나 비공개 상태임을 나타내는 응답만 반환해야 합니다."),
    # PyMuPDF card
    ("CVE-2026-3308(RCE, ≤1.27.0)가 선언 범위 <code>pymupdf&gt;=1.26,&lt;2</code>에 포함됨.",
     "CVE-2026-3308(RCE, 1.27.0 이하)이 현재 선언된 의존성 범위 <code>pymupdf&gt;=1.26,&lt;2</code>에 포함됨."),
    ("<code>&gt;=1.28.0</code>으로 고정하고 보안 권고 검사 도입(C44).",
     "<code>&gt;=1.28.0</code>으로 고정하고 보안 권고 사항 검사 도입(C44)."),
    # PDF active action
    ("원본 파일 수명주기(추출 후 폐기 vs 격리 서빙) 결정이 남은 항목입니다.",
     "원본 파일 수명주기(추출 후 폐기할지, 격리된 상태로 제공할지) 결정이 남은 항목입니다."),
    # competitor table
    ("60MB / 200슬라이드", "60MB, 슬라이드 200장"),
    ("300슬라이드", "슬라이드 300장"),
    # open items
    ("한국어 데크 10-20장의 변환 시간", "슬라이드 10~20장으로 구성된 한국어 데크의 변환 시간"),
    ("Stage-fetchable URL(오브젝트 스토어/CDN 또는 인증된 projection asset 라우트)",
     "Stage에서 가져올 수 있는 실제 URL(오브젝트 스토어/CDN 또는 인증된 프로젝션 자산 라우트)"),
    ("Gotenberg/LO 이미지 다이제스트 + 폰트 번들 + 래스터라이저 버전이",
     "Gotenberg와 LibreOffice(LO)의 컨테이너 이미지 다이제스트, 폰트 번들, 래스터라이저 버전을"),
    ("최악 10×100MiB 소스+복사 ≈ 2GiB", "100MiB 원본 10개와 복사본 10개로 약 2GiB"),
    # verification table
    ("tus-node-server의 Bun 호환", "<code>@tus/server</code>의 Bun 호환성"),
    ("<code>@tus/server@2.4.4</code> Bun 1.3.14 설치·임포트 확인 (verify-bun-tus.md)",
     "<code>@tus/server@2.4.4</code>를 Bun 1.3.14에서 설치 및 임포트 확인 (<code>verify-bun-tus.md</code>)"),
    ("리드가 <code>adapters/base.py</code> 재독 (verify-adapters.md)",
     "리드가 <code>adapters/base.py</code>를 다시 확인 (<code>verify-adapters.md</code>)"),
]

missing = []
for old, new in REPLS:
    if old in s:
        s = s.replace(old, new)
    else:
        missing.append(old[:70])

p.write_text(s, encoding="utf-8", newline="\n")
print(f"applied {len(REPLS) - len(missing)}/{len(REPLS)} replacements")
for m in missing:
    print("NOT FOUND:", m)
