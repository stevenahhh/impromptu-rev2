# -*- coding: utf-8 -*-
"""Apply remaining 2nd-round proofread fixes to report.html (exact-match pass)."""
from pathlib import Path

p = Path(r"C:\Users\steve\Desktop\projects\impromptu-r2\.omo\ulw-research\20260815-150744\report.html")
s = p.read_text(encoding="utf-8")

REPLS = [
    # integration row
    ("<td>private-backend에 주입된 비동기 <b>서브프로세스 어댑터</b>로 기존 CLI 호출.",
     "<td><code>private-backend</code>에 주입된 비동기 <b>서브프로세스 어댑터</b>로 기존 CLI 호출."),
    # PyMuPDF card (raw > in file, ≤ is U+2264)
    ("<p>CVE-2026-3308(RCE, ≤1.27.0)가 선언 범위 <code>pymupdf>=1.26,&lt;2</code>에 포함됨.",
     "<p>CVE-2026-3308(RCE, 1.27.0 이하)이 현재 선언된 의존성 범위 <code>pymupdf&gt;=1.26,&lt;2</code>에 포함됨."),
    # sources list S5
    ("<li><code>infra/migrations/cluster/0001_cluster.sql</code> — large-object REVOKE (S5)</li>",
     "<li><code>infra/migrations/cluster/0001_cluster.sql</code>: 대형 객체 권한 <code>REVOKE</code> (S5)</li>"),
    # lifecycle callout: insert after </ol> of 3.3 (the 3.2 list is the first </ol> after the h3)
    ("  </ol>\n  <div class=\"callout warn\">\n    <b>주의:</b> 가짜 이미지 URL",
     "  </ol>\n  <div class=\"callout\">\n    <b>수명주기 계약 (C62):</b> 업로드 접수와 상태 조회에는 비동기 작업과 폴링을 사용하되, 렌더링은 운영자가 직접 시작합니다. <code>POST multipart</code> → 검증/스테이징/해시 → 작업 레코드 생성 → <code>202 + jobId</code>. 운영자가 대기 작업을 선택해 변환 워커 도구를 수동 실행하고, 워커 도구는 PPTX→PDF→이미지 변환 후 비공개 미리보기로 저장해 <code>READY_PREVIEW</code> 처리. 운영자·발표자가 미리보기를 검토하고 운영자가 승인한 뒤에만 공개 아티팩트로 수동 승격해 <code>createPresentation</code> 실행. (Gotenberg 웹훅은 콜백 인증과 SSRF 방어가 복잡하고 산출물도 PDF에 그치므로 채택하지 않음)\n  </div>\n  <div class=\"callout warn\">\n    <b>주의:</b> 가짜 이미지 URL"),
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
    print("MISSING:", m.replace("\n", "\\n"))
